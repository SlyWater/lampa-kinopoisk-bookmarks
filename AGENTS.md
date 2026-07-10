# AGENTS.md

## Project Notes

- This project contains a Lampa plugin and a Cloudflare Worker proxy for Kinopoisk bookmarks.
- User-facing answers for this workspace must be in Russian.
- Keep the Lampa plugin as a standalone browser script: do not require bundling for `plugin/kinopoisk-bookmarks.js`.
- Do not commit OAuth secrets, cookies, tokens, `.mafile` files, passwords, or real account data.
- The Worker owns secret-bearing OAuth calls. The plugin may store Yandex access/refresh tokens in `Lampa.Storage`, but must never contain `YANDEX_CLIENT_SECRET`.
- In v1 only `watch_later` is synchronized with Kinopoisk. `watching` and `postponed` are local Lampa statuses unless a reliable Kinopoisk write API is verified.
- Ratings are resolved through the Worker endpoint `/ratings/resolve`, currently backed by Alloha data.
- For important code changes, run `npm test` and `npm run check`.

## Accepted API Contract

- `POST /auth/device`
- `POST /auth/token`
- `POST /auth/refresh`
- `GET /bookmarks/list`
- `POST /bookmarks/watch-later/set`
- `POST /bookmarks/watch-later/remove`
- `GET /ratings/resolve`

## Local Decisions

- The project starts from an empty folder and uses Node's built-in test runner, with no package dependencies.
- Cloudflare Worker is the default proxy target, but `worker/node-server.js` supports self-hosted Ubuntu/Node deployment with the same API contract.
- Public default proxy URL is `https://lampa-kp.slywater.ru`; keep it editable through the Lampa settings input.
- Kinopoisk GraphQL query/mutation shape follows the publicly observed `plannedToWatch.add/remove.status` response contract from existing Lampa Kinopoisk plugins.
