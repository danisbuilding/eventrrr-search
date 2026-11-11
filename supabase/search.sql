-- Eventrrr Search: read-only search over Scout IQ + an insert-only query log.
-- Run once in the Scout IQ project (tlwyhxvytmhpcgrismsz) → SQL editor. Safe to re-run.
--
-- What this exposes to the public (anon / publishable key):
--   search_events(params jsonb)  → public event fields only; never scores, raw text, reviewer notes or captions
--   search_meta()                → cities, profiles (slug + name), categories, last sweep time
--   log_search(...) / log_search_action(...) → append-only rows in search_queries / search_actions
-- Nothing here grants direct table access to anon; every read goes through these SECURITY DEFINER functions.

set client_min_messages = warning;
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

-- Accent- and case-folded text for matching ("Zócalo" = "zocalo"). IMMUTABLE wrapper so it can be indexed later.
create or replace function search_fold(t text) returns text
language sql immutable parallel safe
set search_path = public, extensions
as $$ select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(t, ''))) $$;

-- ---------------------------------------------------------------------------------------------------------
-- search_events
-- params (all optional):
--   city          text     city slug, default 'cdmx'
--   from, to      text     ISO timestamps; default now() → now() + 14 days. An occurrence matches when it overlaps.
--   text          text     names, venues, artists, keywords (fuzzy, accent-insensitive)
--   categories    text[]   Eventrrr categories ("Music", "Food & Drink", …)
--   profile       text     profile slug ("dates", "nightlife", …): its score ranks first, else the event's best
--   neighborhood  text
--   free          boolean  only free events
--   max_price     number   price_min at or under this (free events always pass)
--   limit         integer  default 120, max 200
-- Ranking: tier 'top' (score ≥ 3), then 'fill' (2), then 'more' (unscored or "can't tell"). A 1 never appears.
-- Duplicates marked by a reviewer never appear. Past and cancelled events never appear.
-- ---------------------------------------------------------------------------------------------------------
-- search_events_v2 replaces search_events (kept in the database, unused, so nothing had to be dropped).
-- params (all optional): city, from, to (ISO), text (names; fuzzy), categories[], profile, neighborhood, free, max_price,
--   kids, outdoor, venue_types[], activities[] (event_tags, written nightly by eventrrr-scout scout/enrich.py),
--   embedding (512 floats for the question's topic), topic_min (minimum meaning similarity, 0–1; omit to rank only),
--   limit.
create or replace function search_events_v2(params jsonb default '{}'::jsonb)
returns table (
  key text, occurrence_kind text, title text, description text,
  starts_at timestamptz, ends_at timestamptz, all_day boolean, timezone text, ongoing boolean,
  venue text, address text, neighborhood text,
  price_text text, price_min numeric, price_max numeric, currency text, is_free boolean,
  url text, category text, tier text, rank numeric, match numeric
)
language sql stable security definer
set search_path = public, extensions
as $$
with p as (
  select
    coalesce(nullif(params->>'city', ''), 'cdmx')                                         as city,
    coalesce(nullif(params->>'from', '')::timestamptz, now())                              as dfrom,
    coalesce(nullif(params->>'to', '')::timestamptz, now() + interval '14 days')           as dto,
    nullif(search_fold(params->>'text'), '')                                               as q,
    coalesce(array(select jsonb_array_elements_text(
      case when jsonb_typeof(params->'categories') = 'array' then params->'categories' else '[]'::jsonb end)),
      '{}')                                                                                as cats,
    nullif(params->>'profile', '')                                                         as prof,
    nullif(search_fold(params->>'neighborhood'), '')                                       as hood,
    coalesce((params->>'free')::boolean, false)                                            as free_only,
    (params->>'max_price')::numeric                                                        as max_price,
    coalesce((params->>'kids')::boolean, false)                                            as kids,
    coalesce((params->>'outdoor')::boolean, false)                                         as outdoor,
    coalesce(array(select jsonb_array_elements_text(
      case when jsonb_typeof(params->'venue_types') = 'array' then params->'venue_types' else '[]'::jsonb end)),
      '{}')                                                                                as vtypes,
    coalesce(array(select jsonb_array_elements_text(
      case when jsonb_typeof(params->'activities') = 'array' then params->'activities' else '[]'::jsonb end)),
      '{}')                                                                                as acts,
    case when jsonb_typeof(params->'embedding') = 'array' and jsonb_array_length(params->'embedding') = 512
         then (params->'embedding')::text::extensions.vector end                           as qvec,
    (params->>'topic_min')::real                                                           as topic_min,
    least(greatest(coalesce((params->>'limit')::int, 120), 1), 200)                        as lim
),
scores as (
  select ca.occurrence_id,
         max(ca.score) filter (where pr.slug = (select prof from p)) as prof_score,
         max(ca.score)                                               as best_score
  from current_assignments ca
  join profiles pr on pr.id = ca.profile_id
  where ca.score is not null
  group by ca.occurrence_id
),
base as (
  select o.id as occ_id, o.kind,
         -- accuracy check (search_flags): an all-day event whose page gives a time shows that time
         case when e.all_day and fl.time_found is not null then fl.time_found else o.starts_at end as o_start,
         case when e.all_day and fl.time_found is not null then null else o.ends_at end as o_end,
         coalesce(fl.demote, false) as demote,
         e.key, e.title, e.description, (e.all_day and fl.time_found is null) as all_day, e.timezone, e.is_ongoing, e.price_text, e.price_min, e.price_max,
         e.price_currency, e.is_free, e.url, e.eventrrr_category,
         coalesce(v.name, e.venue_text)          as venue_name,
         coalesce(e.address, v.address)          as addr,
         coalesce(e.neighborhood, v.neighborhood) as hood_name,
         s.prof_score, s.best_score,
         coalesce(s.prof_score, s.best_score)    as eff_score,
         -- meaning match between the question's topic and the event (0–1), null without an embedding
         case when p.qvec is not null and t.embedding is not null then (1 - (t.embedding <=> p.qvec))::numeric end as sim
  from occurrences o
  join events e  on e.id = o.event_id
  join cities c  on c.id = e.city_id
  left join venues v on v.id = e.venue_id
  left join scores s on s.occurrence_id = o.id
  left join current_reviews r on r.event_id = e.id
  left join event_tags t on t.event_id = e.id
  left join lateral (
    select bool_or(f.severity = 'demote') as demote,
           max(f.suggested_starts_at) filter (where f.check_name = 'time_found') as time_found
    from search_flags f where f.event_id = e.id and f.status = 'open') fl on true
  cross join p
  where c.slug = p.city
    and e.status in ('live', 'moved')
    and coalesce(r.skip_reason, '') <> 'duplicate'
    -- Superseded re-reads: when a later run read the same page and the same event under a new date,
    -- the older read is stale (its key carries the old date, so it never gets updated).
    and not exists (
      select 1 from events e2
      join runs r2 on r2.id = e2.last_seen_run_id
      join runs r1 on r1.id = e.last_seen_run_id
      where e2.id <> e.id and e2.url = e.url and e2.city_id = e.city_id
        and split_part(e2.key, '|', 1) = split_part(e.key, '|', 1)
        and r2.created_at > r1.created_at)
    and (case when e.all_day and fl.time_found is not null then fl.time_found else o.starts_at end) <= p.dto
    -- still on: timed events count as 4 hours long, all-day ones as the whole day
    and coalesce(case when e.all_day and fl.time_found is not null then fl.time_found + interval '4 hours' end,
                 o.ends_at,
                 o.starts_at + case when e.all_day then interval '1 day' else interval '4 hours' end) >= p.dfrom
    and (cardinality(p.cats) = 0 or e.eventrrr_category = any (p.cats))
    and (not p.kids or t.kid_friendly)
    and (not p.outdoor or t.outdoor)
    and (cardinality(p.vtypes) = 0 or t.venue_type = any (p.vtypes))
    and (cardinality(p.acts) = 0 or t.activity = any (p.acts))
    and (not p.free_only
         or e.is_free
         or e.price_min = 0
         or search_fold(e.price_text) ~ '(gratis|libre|free|sin costo)')
    and (p.max_price is null or e.is_free or e.price_min is null or e.price_min <= p.max_price)
),
scored as (
  select b.*,
         case when p.q is null then 0::real
              else greatest(
                extensions.word_similarity(p.q, search_fold(b.title)) * 2,
                extensions.word_similarity(p.q, search_fold(b.venue_name)) * 1.5,
                extensions.word_similarity(p.q, search_fold(b.hood_name)),
                case when search_fold(b.description) like '%' || p.q || '%' then 0.8 else 0 end)
         end as text_rank,
         case when p.q is null then true
              else extensions.word_similarity(p.q, search_fold(b.title)) >= 0.6
                or extensions.word_similarity(p.q, search_fold(b.venue_name)) >= 0.6
                or extensions.word_similarity(p.q, search_fold(b.hood_name)) >= 0.7
                or search_fold(b.title) like '%' || p.q || '%'
                or search_fold(b.description) like '%' || p.q || '%'
         end as text_ok,
         case when p.hood is null then true
              else search_fold(b.hood_name) like '%' || p.hood || '%'
                or search_fold(b.addr) like '%' || p.hood || '%'
                or extensions.word_similarity(p.hood, search_fold(b.hood_name)) >= 0.6
         end as hood_ok
  from base b cross join p
)
select s.key, s.kind, s.title, left(s.description, 600), s.o_start, s.o_end, s.all_day, s.timezone,
       (s.is_ongoing or (s.o_end is not null and s.o_end - s.o_start > interval '1 day')),
       s.venue_name, s.addr, s.hood_name, s.price_text, s.price_min, s.price_max, s.price_currency, s.is_free,
       s.url, s.eventrrr_category,
       -- a date the source page disputes (search_flags date_mismatch) goes to "Show more" until resolved
       case when s.demote then 'more' when s.eff_score >= 3 then 'top' when s.eff_score = 2 then 'fill' else 'more' end,
       -- one number that orders results; it encodes the tier but never the score itself
       round((case when s.demote then 1 when s.eff_score >= 3 then 3 when s.eff_score = 2 then 2 else 1 end) * 100
             + (case when s.prof_score is not null then 20 else 0 end)
             + coalesce(s.eff_score, 0) * 5
             + s.text_rank::numeric * 10
             + coalesce(s.sim, 0) * 60, 2),
       round(coalesce(s.sim, 0), 3)
from scored s cross join p
where s.hood_ok
  and coalesce(s.eff_score, 0) <> 1
  and s.text_ok
  and (p.topic_min is null or s.sim is null or s.sim >= p.topic_min)
order by 21 desc, s.o_start asc
limit (select lim from p)
$$;

-- ---------------------------------------------------------------------------------------------------------
-- search_meta: what the API needs to understand a question (cities, profiles, categories) + data freshness
-- ---------------------------------------------------------------------------------------------------------
drop function if exists search_meta();
create function search_meta()
returns jsonb
language sql stable security definer
set search_path = public, extensions
as $$
select jsonb_build_object(
  'cities', coalesce((
    select jsonb_agg(jsonb_build_object('slug', c.slug, 'name', c.name, 'timezone', c.timezone,
                                        'currency', c.currency, 'upcoming', x.n) order by x.n desc)
    from cities c
    join lateral (select count(*) as n from events e
                  where e.city_id = c.id and e.status in ('live', 'moved')
                    and coalesce(e.ends_at, e.starts_at) >= now()) x on true
    where x.n > 0), '[]'::jsonb),
  'profiles', coalesce((
    select jsonb_agg(jsonb_build_object('slug', pr.slug, 'name', pr.display_name, 'persona', left(pr.persona, 240)) order by pr.sort_order, pr.slug)
    from profiles pr where pr.active), '[]'::jsonb),
  'categories', jsonb_build_array('Music', 'Clubs & Parties', 'Art & Exhibitions', 'Food & Drink',
    'Creativity & Crafts', 'Talks & Learning', 'Social & Networking', 'Film & Performance',
    'Wellness & Sport', 'Markets & Design', 'Tech', 'Other'),
  'updated_at', (select max(coalesce(r.finished_at, r.created_at)) from runs r where r.status = 'done')
)
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Query log (Scout IQ insight data). No user ids, no IPs: just what was asked and what happened.
-- ---------------------------------------------------------------------------------------------------------
create table if not exists search_queries (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  city          text,
  q             text not null check (char_length(q) <= 300),
  filters       jsonb not null default '{}'::jsonb,
  parser        text,                 -- model name, or 'keyword' when the fallback ran
  result_count  integer,
  top_count     integer,
  latency_ms    integer
);
create index if not exists search_queries_created_idx on search_queries (created_at desc);

create table if not exists search_actions (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  query_id    uuid references search_queries(id),
  action      text not null check (action in ('open', 'add', 'link', 'more')),
  event_key   text check (char_length(event_key) <= 200)
);
create index if not exists search_actions_query_idx on search_actions (query_id);

alter table search_queries enable row level security;
alter table search_actions enable row level security;
-- No policies for anon: the table is unreadable and unwritable directly. Reviewers may read it in Scout later.
drop policy if exists reviewer_read on search_queries;
drop policy if exists reviewer_read on search_actions;
do $$
begin
  if exists (select 1 from pg_proc where proname = 'scout_is_reviewer') then
    execute 'create policy reviewer_read on search_queries for select to authenticated using (scout_is_reviewer())';
    execute 'create policy reviewer_read on search_actions for select to authenticated using (scout_is_reviewer())';
    execute 'grant select on search_queries, search_actions to authenticated';
  end if;
end $$;

drop function if exists log_search(text, text, jsonb, text, integer, integer, integer);
drop function if exists log_search(uuid, text, text, jsonb, text, integer, integer, integer);
create function log_search(id uuid, q text, city text, filters jsonb, parser text,
                           result_count integer, top_count integer, latency_ms integer)
returns uuid
language sql volatile security definer
set search_path = public, extensions
as $$
insert into search_queries (id, q, city, filters, parser, result_count, top_count, latency_ms)
values (coalesce(log_search.id, gen_random_uuid()), left(coalesce(q, ''), 300), left(city, 40),
        case when pg_column_size(filters) <= 4000 then coalesce(filters, '{}'::jsonb) else '{}'::jsonb end,
        left(parser, 60), result_count, top_count, latency_ms)
on conflict (id) do nothing
returning search_queries.id
$$;

drop function if exists log_search_action(uuid, text, text);
create function log_search_action(query_id uuid, action text, event_key text)
returns void
language sql volatile security definer
set search_path = public, extensions
as $$
insert into search_actions (query_id, action, event_key)
select log_search_action.query_id, log_search_action.action, left(log_search_action.event_key, 200)
where log_search_action.action in ('open', 'add', 'link', 'more')
  and (log_search_action.query_id is null
       or exists (select 1 from search_queries sq where sq.id = log_search_action.query_id))
$$;

-- Execute rights: only these four functions, to the public roles.
revoke all on function search_events_v2(jsonb), search_meta(), log_search(uuid, text, text, jsonb, text, integer, integer, integer),
  log_search_action(uuid, text, text), search_fold(text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function search_events_v2(jsonb), search_meta(),
      log_search(uuid, text, text, jsonb, text, integer, integer, integer), log_search_action(uuid, text, text) to anon, authenticated';
  end if;
end $$;
