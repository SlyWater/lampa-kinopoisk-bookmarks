import { formatRatingBadges, mergeBookmarkIndexes, normalizeMovieIds } from '../../shared/core.mjs';

const DEFAULT_ALLOHA_TOKEN = '04941a9a3ca3ac16e2b4327347bbc1';
const DEFAULT_KINOPOISK_GRAPHQL_URL = 'https://graphql.kinopoisk.ru/graphql/';
const DEFAULT_KINOPOISK_APPS_SCRIPT_LIST_URL = 'https://script.google.com/macros/s/AKfycbwQhxl9xQPv46uChWJ1UDg6BjSmefbSlTRUoSZz5f1rZDRvdhAGTi6RHyXwcSeyBtPr/exec';
const TMDB_API_KEY = '4ef0d7355d9ffb5151e987764708ce96';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type'
};

const defaultWorkerHandler = createWorkerHandler({ fetch: (...args) => fetch(...args) });

export default {
  fetch(request, env, ctx) {
    return defaultWorkerHandler(request, env, ctx);
  }
};

export function createWorkerHandler(deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const state = deps.state || {};
  state.bookmarksCache = state.bookmarksCache || new Map();
  state.bookmarksInFlight = state.bookmarksInFlight || new Map();
  state.bookmarksJobs = state.bookmarksJobs || new Map();
  state.bookmarksCacheGeneration = state.bookmarksCacheGeneration || 0;

  return async function handleRequest(request, env = {}, ctx = {}) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

    const url = new URL(request.url);

    try {
      if (url.pathname === '/health') return json({ ok: true });
      if (url.pathname === '/auth/device' && request.method === 'POST') return authDevice(fetchImpl, env, request);
      if (url.pathname === '/auth/token' && request.method === 'POST') return authToken(fetchImpl, env, request, 'device_code');
      if (url.pathname === '/auth/refresh' && request.method === 'POST') return authToken(fetchImpl, env, request, 'refresh_token');
      if (url.pathname === '/bookmarks/list' && request.method === 'GET') return listBookmarks(fetchImpl, env, request, state);
      if (url.pathname === '/bookmarks/sync/start' && request.method === 'POST') return startBookmarksSync(fetchImpl, env, request, state, ctx);
      if (url.pathname === '/bookmarks/sync/status' && request.method === 'GET') return getBookmarksSyncStatus(request, state);
      if (url.pathname === '/bookmarks/watch-later/set' && request.method === 'POST') return mutateWatchLater(fetchImpl, env, request, 'add', state);
      if (url.pathname === '/bookmarks/watch-later/remove' && request.method === 'POST') return mutateWatchLater(fetchImpl, env, request, 'remove', state);
      if (url.pathname === '/ratings/resolve' && (request.method === 'GET' || request.method === 'POST')) return resolveRatings(fetchImpl, env, request);

      return json({ error: 'not_found' }, 404);
    } catch (error) {
      return json({ error: 'internal_error', message: error.message }, 500);
    }
  };
}

async function authDevice(fetchImpl, env, request) {
  requireEnv(env, 'YANDEX_CLIENT_ID');
  const body = await readJson(request);
  const form = new URLSearchParams({
    client_id: env.YANDEX_CLIENT_ID,
    device_id: body.device_id || crypto.randomUUID()
  });

  const data = await upstreamJson(fetchImpl, 'https://oauth.yandex.ru/device/code', {
    method: 'POST',
    body: form
  });

  return json(data, data.error ? 400 : 200);
}

async function authToken(fetchImpl, env, request, grantType) {
  requireEnv(env, 'YANDEX_CLIENT_ID');
  requireEnv(env, 'YANDEX_CLIENT_SECRET');

  const body = await readJson(request);
  const value = grantType === 'refresh_token' ? body.refresh_token : body.device_code;
  if (!value) return json({ error: 'missing_token_value' }, 400);

  const form = new URLSearchParams({
    grant_type: grantType,
    client_id: env.YANDEX_CLIENT_ID,
    client_secret: env.YANDEX_CLIENT_SECRET
  });

  if (grantType === 'refresh_token') form.set('refresh_token', value);
  else form.set('code', value);

  const data = await upstreamJson(fetchImpl, 'https://oauth.yandex.ru/token', {
    method: 'POST',
    body: form
  });

  return json(data, data.error ? 400 : 200);
}

async function listBookmarks(fetchImpl, env, request, state) {
  const token = getBearerToken(request);
  if (!token) return json({ error: 'missing_authorization' }, 401);
  const url = new URL(request.url);
  const enrich = url.searchParams.get('enrich') !== '0';
  const full = url.searchParams.get('full') !== '0';
  const refresh = url.searchParams.get('refresh') === '1';
  const cacheKey = await bookmarksCacheKey(token, { enrich, full });
  const cacheTtl = positiveInteger(env.BOOKMARKS_CACHE_TTL_MS, 300000, 1000, 3600000);
  const cacheGeneration = state.bookmarksCacheGeneration;

  if (!refresh) {
    const cached = getCachedBookmarks(state, cacheKey, cacheTtl);
    if (cached) return json(withCacheDiagnostics(cached, true, false));
  }

  if (state.bookmarksInFlight.has(cacheKey)) {
    const data = await state.bookmarksInFlight.get(cacheKey);
    return json(withCacheDiagnostics(data, true, true));
  }

  const pending = buildBookmarksPayload(fetchImpl, env, token, enrich, full);
  state.bookmarksInFlight.set(cacheKey, pending);

  try {
    const data = await pending;
    if (state.bookmarksCacheGeneration === cacheGeneration) {
      state.bookmarksCache.set(cacheKey, {
        time: Date.now(),
        data: cloneJson(data)
      });
    }
    return json(withCacheDiagnostics(data, false, false));
  } finally {
    state.bookmarksInFlight.delete(cacheKey);
  }
}

async function startBookmarksSync(fetchImpl, env, request, state, ctx) {
  const token = getBearerToken(request);
  if (!token) return json({ error: 'missing_authorization' }, 401);

  cleanupBookmarkJobs(state);
  const url = new URL(request.url);
  const enrich = url.searchParams.get('enrich') !== '0';
  const full = url.searchParams.get('full') !== '0';
  const refresh = url.searchParams.get('refresh') === '1';
  const cacheKey = await bookmarksCacheKey(token, { enrich, full });
  const cacheTtl = positiveInteger(env.BOOKMARKS_CACHE_TTL_MS, 300000, 1000, 3600000);

  if (!refresh) {
    const cached = getCachedBookmarks(state, cacheKey, cacheTtl);
    if (cached) {
      return json({
        status: 'done',
        progress: doneProgress(cached),
        result: withCacheDiagnostics(cached, true, false)
      });
    }
  }

  const cacheGeneration = state.bookmarksCacheGeneration;
  const job = createBookmarkJob();
  state.bookmarksJobs.set(job.id, job);

  const pending = buildBookmarksPayload(fetchImpl, env, token, enrich, full, (progress) => updateBookmarkJob(job, progress))
    .then((data) => {
      if (state.bookmarksCacheGeneration === cacheGeneration) {
        state.bookmarksCache.set(cacheKey, {
          time: Date.now(),
          data: cloneJson(data)
        });
      }
      updateBookmarkJob(job, doneProgress(data));
      job.status = 'done';
      job.result = withCacheDiagnostics(data, false, false);
      job.finishedAt = Date.now();
    })
    .catch((error) => {
      job.status = 'error';
      job.error = error.message || String(error);
      job.message = 'Ошибка синхронизации';
      job.finishedAt = Date.now();
    });

  job.promise = pending;
  if (ctx?.waitUntil) ctx.waitUntil(pending);

  return json({
    jobId: job.id,
    status: job.status,
    progress: publicBookmarkJob(job)
  }, 202);
}

function getBookmarksSyncStatus(request, state) {
  cleanupBookmarkJobs(state);
  const id = new URL(request.url).searchParams.get('id') || '';
  const job = state.bookmarksJobs.get(id);
  if (!job) return json({ error: 'job_not_found' }, 404);
  return json(publicBookmarkJob(job));
}

async function buildBookmarksPayload(fetchImpl, env, token, enrich, full, onProgress) {
  if (onProgress) onProgress({ phase: 'list', message: 'Получаю список Кинопоиска', processed: 0, total: 0 });
  let data = await kinopoiskGraphql(fetchImpl, env, token, WATCH_LATER_QUERY, {});
  let items = extractWatchLaterItems(data);
  let movies = items.map(normalizeKinopoiskListItem).filter(Boolean);
  let movieDedupe = dedupeKinopoiskMovies(movies);
  movies = movieDedupe.items;
  let diagnostics = buildBookmarksDiagnostics(data, movies, 'graphql');
  diagnostics.duplicateMoviesCount = movieDedupe.duplicates;

  if (!movies.length && env.DISABLE_KINOPOISK_APPS_SCRIPT_FALLBACK !== '1') {
    if (onProgress) onProgress({ phase: 'list', message: 'Получаю список через fallback', processed: 0, total: 0 });
    const fallback = await kinopoiskAppsScriptList(fetchImpl, env, token, full);
    const fallbackItems = extractWatchLaterItems(fallback);
    const fallbackMovieDedupe = dedupeKinopoiskMovies(fallbackItems.map(normalizeKinopoiskListItem).filter(Boolean));
    const fallbackMovies = fallbackMovieDedupe.items;

    if (fallbackMovies.length || !diagnostics.hasUserData) {
      data = fallback;
      items = fallbackItems;
      movies = fallbackMovies;
      diagnostics = buildBookmarksDiagnostics(data, movies, 'apps_script');
      diagnostics.duplicateMoviesCount = fallbackMovieDedupe.duplicates;
    } else {
      diagnostics.fallback = buildBookmarksDiagnostics(fallback, fallbackMovies, 'apps_script');
      diagnostics.fallback.duplicateMoviesCount = fallbackMovieDedupe.duplicates;
    }
  }
  if (onProgress) {
    onProgress({
      phase: enrich ? 'cards' : 'done',
      message: enrich ? 'Собираю карточки Lampa' : 'Список получен',
      processed: enrich ? 0 : movies.length,
      total: movies.length,
      moviesCount: movies.length
    });
  }

  const cardResult = enrich ? await buildLampaCards(fetchImpl, env, movies, onProgress) : { cards: [], unresolved: [] };
  diagnostics.cardsCount = cardResult.cards.length;
  diagnostics.fallbackCardsCount = cardResult.fallbacks || 0;
  diagnostics.duplicateCardsCount = cardResult.duplicates || 0;
  diagnostics.unresolvedCount = cardResult.unresolved.length;
  diagnostics.unresolved = cardResult.unresolved.slice(0, 20);

  return {
    movies,
    cards: cardResult.cards,
    bookmarkIndex: mergeBookmarkIndexes({}, movies),
    diagnostics
  };
}

async function mutateWatchLater(fetchImpl, env, request, action, state) {
  const token = getBearerToken(request);
  if (!token) return json({ error: 'missing_authorization' }, 401);

  const body = await readJson(request);
  const ids = normalizeMovieIds(body);
  if (!ids.kinopoiskId) return json({ error: 'missing_kinopoisk_id' }, 400);

  const mutation = action === 'add' ? WATCH_LATER_ADD_MUTATION : WATCH_LATER_REMOVE_MUTATION;
  const data = await kinopoiskGraphql(fetchImpl, env, token, mutation, { movieId: Number(ids.kinopoiskId) });
  const status = data?.data?.movie?.plannedToWatch?.[action]?.status;

  if (status === 'SUCCESS') clearBookmarksCache(state);

  return json({
    ok: status === 'SUCCESS',
    status: status || 'UNKNOWN',
    raw: env.DEBUG_RAW_KINOPOISK === '1' ? data : undefined
  }, status === 'SUCCESS' ? 200 : 502);
}

async function resolveRatings(fetchImpl, env, request) {
  const params = request.method === 'GET' ? Object.fromEntries(new URL(request.url).searchParams) : await readJson(request);
  const ids = normalizeMovieIds(params);
  const token = env.ALLOHA_TOKEN || DEFAULT_ALLOHA_TOKEN;
  const name = params.name || params.title || params.query || '';
  const year = params.year || params.productionYear || '';
  let query = '';

  if (ids.kinopoiskId) query = `kp=${encodeURIComponent(ids.kinopoiskId)}`;
  else if (ids.tmdbId) query = `tmdb=${encodeURIComponent(ids.tmdbId)}`;
  else if (name) query = `name=${encodeURIComponent(name)}${year ? `&year=${encodeURIComponent(year)}` : ''}`;
  else return json({ error: 'missing_movie_id' }, 400);

  const data = await resolveAlloha(fetchImpl, env, query);

  if (data.status !== 'success' || !data.data) return json({ error: 'not_found', raw: data }, 404);

  const movie = data.data;
  return json({
    ids: normalizeMovieIds(movie),
    ratings: {
      kp: movie.rating_kp ?? null,
      imdb: movie.rating_imdb ?? null
    },
    movie: {
      type: movie.category === 2 ? 'tv' : 'movie',
      title: movie.name || '',
      original_title: movie.original_name || '',
      year: movie.year || null,
      poster: movie.poster || '',
      description: movie.description || ''
    },
    badges: formatRatingBadges(movie),
    raw: env.DEBUG_RAW_ALLOHA === '1' ? movie : undefined
  });
}

async function kinopoiskGraphql(fetchImpl, env, token, query, variables) {
  const endpoint = env.KINOPOISK_GRAPHQL_URL || DEFAULT_KINOPOISK_GRAPHQL_URL;
  return upstreamJson(fetchImpl, endpoint, {
    method: 'POST',
    headers: {
      authorization: `OAuth ${token}`,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
}

async function kinopoiskAppsScriptList(fetchImpl, env, token, full = true) {
  const endpoint = env.KINOPOISK_APPS_SCRIPT_LIST_URL || DEFAULT_KINOPOISK_APPS_SCRIPT_LIST_URL;
  const collectedItems = [];
  const limit = Number(env.KINOPOISK_APPS_SCRIPT_PAGE_SIZE || 50);
  const maxItems = Number(env.KINOPOISK_MAX_IMPORT || 500);
  const firstData = await kinopoiskAppsScriptPage(fetchImpl, endpoint, token, { offset: 0, limit });
  const firstItems = extractWatchLaterItems(firstData);
  const total = firstData?.data?.userProfile?.userData?.plannedToWatch?.movies?.total || firstItems.length;
  const pagination = {
    supported: false,
    param: '',
    requestedPages: 1,
    uniquePages: firstItems.length ? 1 : 0,
    total
  };

  collectedItems.push(...firstItems);

  if (full && firstItems.length && firstItems.length < total && collectedItems.length < maxItems) {
    const detected = await detectAppsScriptPagination(fetchImpl, endpoint, token, firstItems, limit);
    if (detected) {
      pagination.supported = true;
      pagination.param = detected.param;
      collectedItems.push(...detected.items);
      pagination.requestedPages += detected.requestedPages;
      pagination.uniquePages += 1;

      let page = 2;
      while (collectedItems.length < total && collectedItems.length < maxItems) {
        const pageData = await kinopoiskAppsScriptPage(fetchImpl, endpoint, token, pageParams(detected.param, page, limit));
        pagination.requestedPages += 1;
        const pageItems = extractWatchLaterItems(pageData);
        if (!pageItems.length || pageHasOnlyKnownItems(pageItems, collectedItems)) break;
        pagination.uniquePages += 1;
        collectedItems.push(...pageItems);
        page += 1;
      }
    } else {
      pagination.requestedPages += 4;
    }
  }

  const result = firstData || {};
  const planned = result?.data?.userProfile?.userData?.plannedToWatch?.movies;
  if (planned) planned.items = collectedItems;
  result._kpPagination = pagination;
  return result;
}

async function detectAppsScriptPagination(fetchImpl, endpoint, token, firstItems, limit) {
  const variants = ['offset', 'skip', 'page', 'start'];

  for (const param of variants) {
    const pageData = await kinopoiskAppsScriptPage(fetchImpl, endpoint, token, pageParams(param, 1, limit));
    const pageItems = extractWatchLaterItems(pageData);
    if (pageItems.length && !pageHasOnlyKnownItems(pageItems, firstItems)) {
      return { param, items: pageItems, requestedPages: 1 };
    }
  }

  return null;
}

async function kinopoiskAppsScriptPage(fetchImpl, endpoint, token, params) {
  const separator = endpoint.includes('?') ? '&' : '?';
  const query = new URLSearchParams({ oauth: token });
  Object.entries(params || {}).forEach(([key, value]) => query.set(key, String(value)));
  return upstreamJson(fetchImpl, `${endpoint}${separator}${query.toString()}`, {
    method: 'GET'
  });
}

function pageParams(param, page, limit) {
  if (param === 'page') return { page: page + 1, limit };
  if (param === 'offset') return { offset: page * limit, limit };
  if (param === 'skip') return { skip: page * limit, limit };
  if (param === 'start') return { start: page * limit, limit };
  return { offset: page * limit, limit };
}

function pageHasOnlyKnownItems(pageItems, knownItems) {
  const known = new Set(knownItems.map((item) => String(item?.movie?.id || item?.item?.id || item?.id || '')).filter(Boolean));
  return pageItems.every((item) => known.has(String(item?.movie?.id || item?.item?.id || item?.id || '')));
}

async function resolveAlloha(fetchImpl, env, query) {
  const token = env.ALLOHA_TOKEN || DEFAULT_ALLOHA_TOKEN;
  return upstreamJson(fetchImpl, `https://api.alloha.tv/?token=${encodeURIComponent(token)}&${query}`, {
    method: 'GET'
  });
}

async function buildLampaCards(fetchImpl, env, movies, onProgress) {
  const cardsByIndex = new Array(movies.length);
  const unresolved = [];
  let fallbackCardsCount = 0;
  let nextIndex = 0;
  let processed = 0;
  const concurrency = Math.min(
    movies.length || 1,
    positiveInteger(env.BOOKMARKS_ENRICH_CONCURRENCY, 3, 1, 16)
  );

  async function worker() {
    while (nextIndex < movies.length) {
      const currentIndex = nextIndex++;
      const movie = movies[currentIndex];
      try {
        const card = await buildLampaCard(fetchImpl, env, movie);
        if (card) {
          cardsByIndex[currentIndex] = card;
          if (card.kp_bookmarks_fallback) fallbackCardsCount += 1;
        }
        else unresolved.push({
          kinopoisk_id: movie.kinopoisk_id,
          title: movie.title,
          year: movie.year
        });
      } catch (error) {
        unresolved.push({
          kinopoisk_id: movie.kinopoisk_id,
          title: movie.title,
          year: movie.year,
          error: error.message || String(error)
        });
      } finally {
        processed += 1;
        if (onProgress) {
          onProgress({
            phase: 'cards',
            message: 'Собираю карточки Lampa',
            processed,
            total: movies.length,
            cardsCount: cardsByIndex.filter(Boolean).length,
            fallbackCardsCount,
            unresolvedCount: unresolved.length
          });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const deduped = dedupeLampaCards(cardsByIndex.filter(Boolean));
  return { cards: deduped.items, unresolved, duplicates: deduped.duplicates, fallbacks: fallbackCardsCount };
}

async function buildLampaCard(fetchImpl, env, movie) {
  const resolved = await resolveAlloha(fetchImpl, env, `kp=${encodeURIComponent(movie.kinopoisk_id)}`);
  const alloha = resolved?.data || {};
  const tmdbId = alloha.id_tmdb;
  const imdbId = alloha.id_imdb || movie.imdb_id || movie.imdbId;
  const type = alloha.category === 2 ? 'tv' : 'movie';
  let card = null;

  if (tmdbId) card = await fetchTmdb(fetchImpl, env, type, tmdbId);
  if (!card && imdbId) card = await fetchTmdbByImdb(fetchImpl, env, imdbId, movie, alloha);
  if (!card) card = await strictTmdbSearch(fetchImpl, env, movie, alloha);
  if (!card) card = buildKinopoiskFallbackCard(movie, alloha);
  if (!card) return null;

  card.source = 'tmdb';
  card.kinopoisk_id = String(movie.kinopoisk_id);
  card.id_kp = String(movie.kinopoisk_id);
  return card;
}

async function fetchTmdb(fetchImpl, env, type, tmdbId) {
  const domain = env.TMDB_PROXY_DOMAIN || 'cub.red';
  const url = `https://tmdb.${domain}/3/${type}/${encodeURIComponent(tmdbId)}?api_key=${TMDB_API_KEY}&language=ru`;
  const data = await upstreamJson(fetchImpl, url, { method: 'GET' });
  if (data?.error || !data?.id) return null;
  return data;
}

async function fetchTmdbByImdb(fetchImpl, env, imdbId, movie, alloha) {
  const domain = env.TMDB_PROXY_DOMAIN || 'cub.red';
  const url = `https://tmdb.${domain}/3/find/${encodeURIComponent(imdbId)}?api_key=${TMDB_API_KEY}&external_source=imdb_id&language=ru`;
  const data = await upstreamJson(fetchImpl, url, { method: 'GET' });
  if (data?.error) return null;

  const candidates = [
    ...(Array.isArray(data?.movie_results) ? data.movie_results.map((card) => ({ card, type: 'movie' })) : []),
    ...(Array.isArray(data?.tv_results) ? data.tv_results.map((card) => ({ card, type: 'tv' })) : [])
  ];
  const year = alloha.year || movie.year;
  const preferred = candidates.find((candidate) => isStrictTmdbMatch(candidate.card, movie, alloha, candidate.type, year)) || candidates[0];
  return preferred?.card || null;
}

async function strictTmdbSearch(fetchImpl, env, movie, alloha) {
  const year = alloha.year || movie.year;
  const titles = uniqueTruthy([
    alloha.original_name,
    alloha.name,
    movie.original_title,
    movie.title
  ]);
  if (!titles.length || !year) return null;

  const types = alloha.category === 2 ? ['tv'] : alloha.category === 1 ? ['movie'] : ['movie', 'tv'];
  const domain = env.TMDB_PROXY_DOMAIN || 'cub.red';
  let bestYearMatch = null;

  for (const type of types) {
    const path = type === 'tv' ? 'search/tv' : 'search/movie';
    const yearParam = type === 'tv' ? 'first_air_date_year' : 'year';

    for (const title of titles) {
      const url = `https://tmdb.${domain}/3/${path}?query=${encodeURIComponent(title)}&api_key=${TMDB_API_KEY}&${yearParam}=${encodeURIComponent(year)}&language=ru`;
      let data;
      try {
        data = await upstreamJson(fetchImpl, url, { method: 'GET' });
      } catch {
        continue;
      }
      const results = Array.isArray(data?.results) ? data.results : [];
      const matched = results.find((candidate) => isStrictTmdbMatch(candidate, movie, alloha, type, year));
      if (matched) return matched;
      if (!bestYearMatch) bestYearMatch = results.find((candidate) => tmdbCandidateYear(candidate, type) === String(year));
    }
  }

  return bestYearMatch || null;
}

function isStrictTmdbMatch(candidate, movie, alloha, type, year) {
  const candidateYear = tmdbCandidateYear(candidate, type);
  if (candidateYear && String(year) !== candidateYear) return false;

  const expected = normalizeTitle(alloha.original_name || movie.original_title || movie.title);
  const localized = normalizeTitle(movie.title);
  const candidateTitles = [
    candidate.title,
    candidate.name,
    candidate.original_title,
    candidate.original_name
  ].map(normalizeTitle).filter(Boolean);

  return candidateTitles.includes(expected) || candidateTitles.includes(localized);
}

function tmdbCandidateYear(candidate, type) {
  return String((type === 'tv' ? candidate.first_air_date : candidate.release_date) || '').slice(0, 4);
}

function buildKinopoiskFallbackCard(movie, alloha) {
  const id = Number(movie.kinopoisk_id);
  if (!id) return null;

  const title = alloha.name || movie.title || movie.original_title || `Kinopoisk ${movie.kinopoisk_id}`;
  const original = alloha.original_name || movie.original_title || title;
  const poster = alloha.poster || movie.poster || '';
  const year = alloha.year || movie.year || '';

  return {
    id: 900000000 + id,
    source: 'tmdb',
    title,
    original_title: original,
    release_date: year ? `${year}-01-01` : '',
    vote_average: 0,
    poster_path: poster,
    poster,
    img: poster,
    overview: alloha.description || '',
    kp_bookmarks_fallback: true
  };
}

function normalizeTitle(title) {
  return String(title || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
}

function uniqueTruthy(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

async function upstreamJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: 'invalid_json', body: text };
  }

  if (!response.ok) {
    return {
      error: data.error || 'upstream_error',
      status: response.status,
      details: data
    };
  }

  return data;
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text);
}

function getBearerToken(request) {
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireEnv(env, key) {
  if (!env[key]) throw new Error(`Missing env variable: ${key}`);
}

function normalizeKinopoiskListItem(item) {
  const movie = item.movie || item.item || item;
  if (!movie || !movie.id) return null;
  const title = movie.title?.localized || movie.title?.russian || movie.title?.original || movie.name || '';
  const originalTitle = movie.title?.original || movie.originalName || movie.original_title || title;

  return {
    kinopoisk_id: String(movie.id),
    title,
    original_title: originalTitle,
    year: movie.productionYear || movie.year || null,
    poster: normalizeKinopoiskPoster(movie),
    updatedAt: item.createdAt || item.updatedAt || new Date(0).toISOString()
  };
}

function normalizeKinopoiskPoster(movie) {
  const candidate = movie.poster?.url || movie.poster?.previewUrl || movie.poster?.avatarsUrl || movie.posterUrl || movie.poster || movie.cover?.url || '';
  if (!candidate || typeof candidate !== 'string') return '';
  if (candidate.startsWith('//')) return `https:${candidate}`;
  if (candidate.startsWith('http')) return candidate;
  return candidate;
}

function dedupeKinopoiskMovies(movies) {
  const seen = new Set();
  const items = [];
  let duplicates = 0;

  for (const movie of movies) {
    const key = movie?.kinopoisk_id ? `kp:${movie.kinopoisk_id}` : `${movie?.title || ''}:${movie?.year || ''}`;
    if (!key || seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    items.push(movie);
  }

  return { items, duplicates };
}

function dedupeLampaCards(cards) {
  const seen = new Set();
  const items = [];
  let duplicates = 0;

  for (const card of cards) {
    const key = lampaCardKey(card);
    if (!key || seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    items.push(card);
  }

  return { items, duplicates };
}

function lampaCardKey(card) {
  if (!card) return '';
  if (card.kinopoisk_id || card.id_kp) return `kp:${card.kinopoisk_id || card.id_kp}`;
  if (!card.id) return '';
  const type = card.name && !card.title ? 'tv' : 'movie';
  return `${type}:${card.id}`;
}

function extractWatchLaterItems(data) {
  return data?.data?.userProfile?.userData?.plannedToWatch?.movies?.items || [];
}

function buildBookmarksDiagnostics(data, movies, source) {
  const userProfile = data?.data?.userProfile;
  const userData = userProfile?.userData;
  const plannedToWatch = userData?.plannedToWatch;
  const plannedMovies = plannedToWatch?.movies;

  return {
    source,
    hasData: Boolean(data?.data),
    hasUserProfile: Boolean(userProfile),
    hasUserData: Boolean(userData),
    hasPlannedToWatch: Boolean(plannedToWatch),
    dataKeys: data?.data ? Object.keys(data.data) : [],
    userDataKeys: userData ? Object.keys(userData) : [],
    plannedToWatchKeys: plannedToWatch ? Object.keys(plannedToWatch) : [],
    total: plannedMovies?.total ?? null,
    rawItemsCount: Array.isArray(plannedMovies?.items) ? plannedMovies.items.length : null,
    parsedMoviesCount: movies.length,
    pagination: data?._kpPagination || null,
    topLevelError: data?.error || '',
    upstreamStatus: data?.status || null,
    errors: Array.isArray(data?.errors) ? data.errors.map((error) => ({
      message: error.message || '',
      path: error.path || null
    })) : []
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function createBookmarkJob() {
  const now = Date.now();
  return {
    id: randomId(),
    status: 'running',
    phase: 'list',
    message: 'Запускаю синхронизацию',
    processed: 0,
    total: 0,
    moviesCount: 0,
    cardsCount: 0,
    unresolvedCount: 0,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    result: null,
    error: ''
  };
}

function updateBookmarkJob(job, progress) {
  Object.assign(job, progress || {});
  job.updatedAt = Date.now();
}

function publicBookmarkJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    message: job.message,
    processed: Number(job.processed || 0),
    total: Number(job.total || 0),
    moviesCount: Number(job.moviesCount || 0),
    cardsCount: Number(job.cardsCount || 0),
    fallbackCardsCount: Number(job.fallbackCardsCount || 0),
    unresolvedCount: Number(job.unresolvedCount || 0),
    percent: job.total ? Math.min(100, Math.round((Number(job.processed || 0) / Number(job.total)) * 100)) : 0,
    error: job.error || '',
    result: job.status === 'done' ? job.result : undefined
  };
}

function doneProgress(data) {
  const total = (data.movies || []).length;
  return {
    phase: 'done',
    message: 'Синхронизация завершена',
    processed: total,
    total,
    moviesCount: total,
    cardsCount: (data.cards || []).length,
    fallbackCardsCount: data.diagnostics?.fallbackCardsCount || 0,
    unresolvedCount: data.diagnostics?.unresolvedCount || 0
  };
}

function cleanupBookmarkJobs(state) {
  const now = Date.now();
  for (const [id, job] of state.bookmarksJobs) {
    const age = now - (job.finishedAt || job.startedAt || now);
    if (age > 10 * 60 * 1000) state.bookmarksJobs.delete(id);
  }
}

function getCachedBookmarks(state, key, ttl) {
  const entry = state.bookmarksCache.get(key);
  if (!entry || Date.now() - entry.time > ttl) return null;
  return entry.data;
}

function withCacheDiagnostics(data, cacheHit, inFlight) {
  const cloned = cloneJson(data);
  cloned.diagnostics = {
    ...(cloned.diagnostics || {}),
    cacheHit,
    inFlight
  };
  return cloned;
}

function clearBookmarksCache(state) {
  state.bookmarksCache.clear();
  state.bookmarksInFlight.clear();
  state.bookmarksCacheGeneration = (state.bookmarksCacheGeneration || 0) + 1;
}

async function bookmarksCacheKey(token, params) {
  return `${await sha256Hex(token)}:enrich=${params.enrich ? 1 : 0}:full=${params.full ? 1 : 0}`;
}

async function sha256Hex(value) {
  if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
    const bytes = new TextEncoder().encode(String(value));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv:${(hash >>> 0).toString(16)}`;
}

function positiveInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const WATCH_LATER_QUERY = `
query LampaKinopoiskWatchLater {
  userProfile {
    userData {
      plannedToWatch {
        movies {
          total
          items {
            createdAt
            movie {
              id
              title {
                localized
                original
              }
              productionYear
            }
          }
        }
      }
    }
  }
}`;

const WATCH_LATER_ADD_MUTATION = `
mutation LampaKinopoiskWatchLaterAdd($movieId: Long!) {
  movie(id: $movieId) {
    plannedToWatch {
      add {
        status
      }
    }
  }
}`;

const WATCH_LATER_REMOVE_MUTATION = `
mutation LampaKinopoiskWatchLaterRemove($movieId: Long!) {
  movie(id: $movieId) {
    plannedToWatch {
      remove {
        status
      }
    }
  }
}`;
