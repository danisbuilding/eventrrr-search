-- Cities in Eventrrr Search (Scout IQ project). search_status: live = selectable in the city menu,
-- soon = listed as "Coming soon", hidden = not listed. A city also needs Scout sweeping it before it's useful.
alter table cities add column if not exists search_status text not null default 'hidden';
alter table cities add column if not exists sort_order int not null default 100;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cities_search_status_check') then
    alter table cities add constraint cities_search_status_check check (search_status in ('live', 'soon', 'hidden'));
  end if;
end $$;
update cities set search_status = 'live', sort_order = 1 where slug = 'cdmx';
insert into cities (name, slug, country, timezone, currency, search_status, sort_order) values
  ('New York', 'nyc', 'US', 'America/New_York', 'USD', 'hidden', 10),
  ('Dallas', 'dallas', 'US', 'America/Chicago', 'USD', 'hidden', 11),
  ('Lisbon', 'lisbon', 'PT', 'Europe/Lisbon', 'EUR', 'hidden', 12)
on conflict (slug) do nothing;
-- To list one:  update cities set search_status = 'soon' where slug = 'nyc';
