# Eventrrr Search

**search.eventrrr.com** — pick When and What (Eventrrr's categories), optionally More filters and a small keyword,
and see every matching event from Scout IQ by day; tap + to save one to your Eventrrr calendar. Plan: [Eventrrr Search: Build Plan v1](https://claude.ai/artifact/B8enfEDcQm5J1U8ACriZua).

| Part | Where |
| --- | --- |
| Screens | `public/` (plain HTML/CSS/JS, no build step) |
| Search API | `functions/api/search.js` → `lib/` (Cloudflare Pages Functions) |
| Event data | Scout IQ Supabase, via `supabase/search.sql` (`search_events`, `search_meta`, query log) |
| Saving | Eventrrr Supabase, via `add_from_search` (see `docs/bolt-add-from-search-prompt.md`) |
| Deploy | `.github/workflows/deploy.yml` on every push to `main` |
| Nightly check | `.github/workflows/check.yml` |

## Everyday changes (no Claude needed)

| Task | How |
| --- | --- |
| Change the headlines | Edit `public/config/headlines.json` on github.com → Commit. Live in about a minute. |
| New city | Nothing: any city with upcoming events in Scout IQ appears automatically. |
| Turn on saving | After the Bolt prompt has run, set `savingEnabled: true` in `public/config.js`. |
| Rotate a key | Update the GitHub secret, then Actions → deploy → Run workflow. |
| Change the parsing model | `OPENAI_MODEL` in `wrangler.toml`. |

## How it finds events (filter-first since 2026-11-12)

The page sends the picked filters (`browse: true`); no AI reads anything. Every match is shown: dated events by day,
ongoing ones under "Also on". A keyword matches titles (English and original), venues, neighborhoods and descriptions;
if the whole keyword matches nothing, any of its 4+-letter words will do, and if that fails too it's dropped with a note
and the other filters still apply. The state lives in the URL (`?when=weekend&what=Music&kw=roma&price=free&time=evening
&setting=indoor&kids=1&ongoing=show`; ongoing events are hidden unless `ongoing=show`). Old `?q=` links are read with the keyword rules (no AI) and turned into filters.

The sentence-reading path (OpenAI parser, embeddings, relaxation) is still in `lib/search.js` and `lib/parse.js` but the
page no longer calls it; a request with `q` and no `filters` still uses it.

## How ranking works (sentence path)

`search_events` scores each event with the profile that matches the question (else its best profile score):
3+ first, 2s fill the first screen up to 10 events, unscored and "can't tell" events sit behind "Show more",
1s and reviewer-marked duplicates never appear. The browser never receives a score.

If OpenAI is down or slow (4 s), a keyword parser takes over, so search keeps working.

## When something breaks

1. Actions tab: did `deploy` or `check` fail? The log says which step.
2. Status pages: [Cloudflare](https://www.cloudflarestatus.com), [Supabase](https://status.supabase.com), [OpenAI](https://status.openai.com).
3. Roll back: Cloudflare → Workers & Pages → eventrrr-search → Deployments → pick the last good one → Rollback.
4. Scout IQ paused? It shouldn't (Scout's weekly keepalive), but Supabase → project → Restore brings it back.

## Local development

```
npm install
printf 'SCOUT_IQ_URL=https://tlwyhxvytmhpcgrismsz.supabase.co\nSCOUT_IQ_PUBLISHABLE_KEY=sb_publishable_…\n' > .dev.vars
npm run dev     # http://localhost:8788
npm test
```
