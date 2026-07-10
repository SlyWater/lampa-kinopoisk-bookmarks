# AGENTS.md

## Project Notes

- This project contains a Lampa plugin and a Cloudflare Worker proxy for Kinopoisk bookmarks.
- User-facing answers for this workspace must be in Russian.
- Keep the Lampa plugin as a standalone browser script: do not require bundling for `plugin/kinopoisk-bookmarks.js`.
- Do not commit OAuth secrets, cookies, tokens, `.mafile` files, passwords, or real account data.
- The Worker owns secret-bearing OAuth calls. The plugin may store Yandex access/refresh tokens in `Lampa.Storage`, but must never contain `YANDEX_CLIENT_SECRET`.
- In v1 only `watch_later` is synchronized with Kinopoisk. `watching` and `postponed` are local Lampa statuses unless a reliable Kinopoisk write API is verified.
- Kinopoisk `watch_later` is shown in a dedicated Lampa component/menu item named `Watch later`; do not write imported items into the standard Lampa `wath`/`Later` favorites unless the user explicitly asks.
- Ratings are resolved through the Worker endpoint `/ratings/resolve`, currently backed by Alloha data.
- For important code changes, run `npm test` and `npm run check`.

## Accepted API Contract

- `POST /auth/device`
- `POST /auth/token`
- `POST /auth/refresh`
- `GET /bookmarks/list`
- `POST /bookmarks/sync/start`
- `GET /bookmarks/sync/status`
- `POST /bookmarks/watch-later/set`
- `POST /bookmarks/watch-later/remove`
- `GET /ratings/resolve`

## Local Decisions

- The project starts from an empty folder and uses Node's built-in test runner, with no package dependencies.
- Cloudflare Worker is the default proxy target, but `worker/node-server.js` supports self-hosted Ubuntu/Node deployment with the same API contract.
- Public default proxy URL is `https://lampa-kp.slywater.ru`; keep it editable through the Lampa settings input.
- Kinopoisk GraphQL query/mutation shape follows the publicly observed `plannedToWatch.add/remove.status` response contract from existing Lampa Kinopoisk plugins.
- `/bookmarks/list` may be slow because it enriches Kinopoisk items into TMDB cards; the backend uses short in-memory per-token caching plus in-flight request sharing, and the plugin blocks parallel sync starts.
- Watch-later cards must be deduplicated by Kinopoisk id first, then by TMDB media type/id fallback.
- Manual watch-later sync uses in-memory backend jobs (`/bookmarks/sync/start`, `/bookmarks/sync/status`) so the Lampa plugin can show progress while cards are being enriched.
- Do not auto-sync watch-later on plugin startup; it can block manual progress UI. Use local cached items until the user starts sync.
- Backend enrichment should prefer direct TMDB id, then IMDb `find`, then strict title/year search. If no TMDB card is safe, return a marked Kinopoisk fallback card so the bookmark remains visible.
- Apps Script fallback pagination is auto-detected across `offset`, `skip`, `page`, and `start`; diagnostics must expose whether pagination is actually supported by the external script.
