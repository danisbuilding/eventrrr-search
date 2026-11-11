# Eventrrr Search

**search.eventrrr.com** — type what you're in the mood for, get events worth going to from Scout IQ, tap + to save one
to your Eventrrr calendar. Plan: [Eventrrr Search: Build Plan v1](https://claude.ai/artifact/B8enfEDcQm5J1U8ACriZua).

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
| Change the suggestion chips | Edit `suggestions` in `public/config.js`. |
| New city | Nothing: any city with upcoming events in Scout IQ appears automatically. |
| Turn on saving | After the Bolt prompt has run, set `savingEnabled: true` in `public/config.js`. |
| Rotate a key | Update the GitHub secret, then Actions → deploy → Run workflow. |
| Change the parsing model | `OPENAI_MODEL` in `wrangler.toml`. |

## How ranking works

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
