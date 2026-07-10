import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkerHandler } from '../worker/src/index.js';

test('GET /ratings/resolve maps Alloha response to ids and badges', async () => {
  const handler = createWorkerHandler({
    fetch: async (url) => {
      assert.match(String(url), /api\.alloha\.tv/);
      return jsonResponse({
        status: 'success',
        data: {
          id_kp: 326,
          id_tmdb: 278,
          id_imdb: 'tt0111161',
          rating_kp: 9.111,
          rating_imdb: 9.3
        }
      });
    }
  });

  const response = await handler(new Request('https://worker.test/ratings/resolve?kp=326'));
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.deepEqual(data.ids, { tmdbId: '278', kinopoiskId: '326', imdbId: 'tt0111161' });
  assert.equal(data.movie.type, 'movie');
  assert.deepEqual(data.badges, [
    { source: 'KP', value: '9.1' },
    { source: 'IMDb', value: '9.3' }
  ]);
});

test('GET /ratings/resolve can search Alloha by name and year', async () => {
  const handler = createWorkerHandler({
    fetch: async (url) => {
      assert.match(String(url), /name=The%20Movie/);
      assert.match(String(url), /year=2026/);
      return jsonResponse({
        status: 'success',
        data: {
          id_kp: 100,
          id_tmdb: 200,
          id_imdb: 'tt100',
          category: 2,
          rating_kp: 7.4,
          rating_imdb: 7.1
        }
      });
    }
  });

  const response = await handler(new Request('https://worker.test/ratings/resolve?name=The+Movie&year=2026'));
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.equal(data.ids.kinopoiskId, '100');
  assert.equal(data.movie.type, 'tv');
});

test('GET /bookmarks/list reads plannedToWatch from Kinopoisk GraphQL', async () => {
  const handler = createWorkerHandler({
    fetch: async (url, options) => {
      assert.match(String(url), /graphql\.kinopoisk\.ru/);
      assert.equal(options.headers.authorization, 'OAuth token');
      return jsonResponse({
        data: {
          userProfile: {
            userData: {
              plannedToWatch: {
                movies: {
                  total: 1,
                  items: [
                    {
                      createdAt: '2026-01-01T00:00:00.000Z',
                      movie: {
                        id: 326,
                        title: { localized: 'Побег из Шоушенка', original: 'The Shawshank Redemption' },
                        productionYear: 1994
                      }
                    }
                  ]
                }
              }
            }
          }
        }
      });
    }
  });

  const response = await handler(new Request('https://worker.test/bookmarks/list', {
    headers: { authorization: 'Bearer token' }
  }));
  assert.equal(response.status, 200);

  const data = await response.json();
  assert.equal(data.movies[0].kinopoisk_id, '326');
  assert.equal(data.bookmarkIndex['kp:326'].status, 'watch_later');
  assert.equal(data.diagnostics.hasPlannedToWatch, true);
  assert.equal(data.diagnostics.total, 1);
});

test('POST /bookmarks/watch-later/set returns success for GraphQL SUCCESS status', async () => {
  const handler = createWorkerHandler({
    fetch: async (url, options) => {
      const payload = JSON.parse(options.body);
      assert.equal(payload.variables.movieId, 326);
      return jsonResponse({
        data: {
          movie: {
            plannedToWatch: {
              add: { status: 'SUCCESS' }
            }
          }
        }
      });
    }
  });

  const response = await handler(new Request('https://worker.test/bookmarks/watch-later/set', {
    method: 'POST',
    headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify({ kinopoisk_id: '326' })
  }));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test('POST /auth/token sends device-code OAuth exchange through Worker secret', async () => {
  const handler = createWorkerHandler({
    fetch: async (url, options) => {
      assert.equal(String(url), 'https://oauth.yandex.ru/token');
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'device_code');
      assert.equal(form.get('client_id'), 'client');
      assert.equal(form.get('client_secret'), 'secret');
      assert.equal(form.get('code'), 'device');
      return jsonResponse({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    }
  });

  const response = await handler(new Request('https://worker.test/auth/token', {
    method: 'POST',
    body: JSON.stringify({ device_code: 'device' })
  }), {
    YANDEX_CLIENT_ID: 'client',
    YANDEX_CLIENT_SECRET: 'secret'
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json()).access_token, 'access');
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
