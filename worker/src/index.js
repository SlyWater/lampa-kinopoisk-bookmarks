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

export default {
  fetch(request, env, ctx) {
    return createWorkerHandler({ fetch })(request, env, ctx);
  }
};

export function createWorkerHandler(deps = {}) {
  const fetchImpl = deps.fetch || fetch;

  return async function handleRequest(request, env = {}) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

    const url = new URL(request.url);

    try {
      if (url.pathname === '/health') return json({ ok: true });
      if (url.pathname === '/auth/device' && request.method === 'POST') return authDevice(fetchImpl, env, request);
      if (url.pathname === '/auth/token' && request.method === 'POST') return authToken(fetchImpl, env, request, 'device_code');
      if (url.pathname === '/auth/refresh' && request.method === 'POST') return authToken(fetchImpl, env, request, 'refresh_token');
      if (url.pathname === '/bookmarks/list' && request.method === 'GET') return listBookmarks(fetchImpl, env, request);
      if (url.pathname === '/bookmarks/watch-later/set' && request.method === 'POST') return mutateWatchLater(fetchImpl, env, request, 'add');
      if (url.pathname === '/bookmarks/watch-later/remove' && request.method === 'POST') return mutateWatchLater(fetchImpl, env, request, 'remove');
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

async function listBookmarks(fetchImpl, env, request) {
  const token = getBearerToken(request);
  if (!token) return json({ error: 'missing_authorization' }, 401);
  const url = new URL(request.url);
  const enrich = url.searchParams.get('enrich') !== '0';
  const full = url.searchParams.get('full') !== '0';

  let data = await kinopoiskGraphql(fetchImpl, env, token, WATCH_LATER_QUERY, {});
  let items = extractWatchLaterItems(data);
  let movies = items.map(normalizeKinopoiskListItem).filter(Boolean);
  let diagnostics = buildBookmarksDiagnostics(data, movies, 'graphql');

  if (!movies.length && env.DISABLE_KINOPOISK_APPS_SCRIPT_FALLBACK !== '1') {
    const fallback = await kinopoiskAppsScriptList(fetchImpl, env, token, full);
    const fallbackItems = extractWatchLaterItems(fallback);
    const fallbackMovies = fallbackItems.map(normalizeKinopoiskListItem).filter(Boolean);

    if (fallbackMovies.length || !diagnostics.hasUserData) {
      data = fallback;
      items = fallbackItems;
      movies = fallbackMovies;
      diagnostics = buildBookmarksDiagnostics(data, movies, 'apps_script');
    } else {
      diagnostics.fallback = buildBookmarksDiagnostics(fallback, fallbackMovies, 'apps_script');
    }
  }
  const cardResult = enrich ? await buildLampaCards(fetchImpl, env, movies) : { cards: [], unresolved: [] };
  diagnostics.cardsCount = cardResult.cards.length;
  diagnostics.unresolvedCount = cardResult.unresolved.length;
  diagnostics.unresolved = cardResult.unresolved.slice(0, 20);

  return json({
    movies,
    cards: cardResult.cards,
    bookmarkIndex: mergeBookmarkIndexes({}, movies),
    diagnostics
  });
}

async function mutateWatchLater(fetchImpl, env, request, action) {
  const token = getBearerToken(request);
  if (!token) return json({ error: 'missing_authorization' }, 401);

  const body = await readJson(request);
  const ids = normalizeMovieIds(body);
  if (!ids.kinopoiskId) return json({ error: 'missing_kinopoisk_id' }, 400);

  const mutation = action === 'add' ? WATCH_LATER_ADD_MUTATION : WATCH_LATER_REMOVE_MUTATION;
  const data = await kinopoiskGraphql(fetchImpl, env, token, mutation, { movieId: Number(ids.kinopoiskId) });
  const status = data?.data?.movie?.plannedToWatch?.[action]?.status;

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
  let firstData = null;
  let lastData = null;
  let offset = 0;
  const limit = Number(env.KINOPOISK_APPS_SCRIPT_PAGE_SIZE || 50);
  const maxItems = Number(env.KINOPOISK_MAX_IMPORT || 500);

  do {
    const separator = endpoint.includes('?') ? '&' : '?';
    const pageData = await upstreamJson(fetchImpl, `${endpoint}${separator}oauth=${encodeURIComponent(token)}&offset=${offset}`, {
      method: 'GET'
    });
    if (!firstData) firstData = pageData;
    lastData = pageData;

    const pageItems = extractWatchLaterItems(pageData);
    collectedItems.push(...pageItems);

    const total = pageData?.data?.userProfile?.userData?.plannedToWatch?.movies?.total || collectedItems.length;
    offset += limit;
    if (!full || !pageItems.length || collectedItems.length >= total || collectedItems.length >= maxItems) break;
  } while (true);

  const result = firstData || lastData || {};
  const planned = result?.data?.userProfile?.userData?.plannedToWatch?.movies;
  if (planned) planned.items = collectedItems;
  return result;
}

async function resolveAlloha(fetchImpl, env, query) {
  const token = env.ALLOHA_TOKEN || DEFAULT_ALLOHA_TOKEN;
  return upstreamJson(fetchImpl, `https://api.alloha.tv/?token=${encodeURIComponent(token)}&${query}`, {
    method: 'GET'
  });
}

async function buildLampaCards(fetchImpl, env, movies) {
  const cards = [];
  const unresolved = [];

  for (const movie of movies) {
    const card = await buildLampaCard(fetchImpl, env, movie);
    if (card) cards.push(card);
    else unresolved.push({
      kinopoisk_id: movie.kinopoisk_id,
      title: movie.title,
      year: movie.year
    });
  }

  return { cards, unresolved };
}

async function buildLampaCard(fetchImpl, env, movie) {
  const resolved = await resolveAlloha(fetchImpl, env, `kp=${encodeURIComponent(movie.kinopoisk_id)}`);
  const alloha = resolved?.data || {};
  const tmdbId = alloha.id_tmdb;
  const type = alloha.category === 2 ? 'tv' : 'movie';
  let card = null;

  if (tmdbId) card = await fetchTmdb(fetchImpl, env, type, tmdbId);
  if (!card) card = await strictTmdbSearch(fetchImpl, env, movie, alloha);
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

async function strictTmdbSearch(fetchImpl, env, movie, alloha) {
  const type = alloha.category === 2 ? 'tv' : 'movie';
  const title = alloha.original_name || movie.original_title || movie.title;
  const year = alloha.year || movie.year;
  if (!title || !year) return null;

  const domain = env.TMDB_PROXY_DOMAIN || 'cub.red';
  const path = type === 'tv' ? 'search/tv' : 'search/movie';
  const yearParam = type === 'tv' ? 'first_air_date_year' : 'year';
  const url = `https://tmdb.${domain}/3/${path}?query=${encodeURIComponent(title)}&api_key=${TMDB_API_KEY}&${yearParam}=${encodeURIComponent(year)}&language=ru`;
  const data = await upstreamJson(fetchImpl, url, { method: 'GET' });
  const results = Array.isArray(data?.results) ? data.results : [];
  const matched = results.find((candidate) => isStrictTmdbMatch(candidate, movie, alloha, type, year));
  return matched || null;
}

function isStrictTmdbMatch(candidate, movie, alloha, type, year) {
  const candidateYear = String((type === 'tv' ? candidate.first_air_date : candidate.release_date) || '').slice(0, 4);
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

function normalizeTitle(title) {
  return String(title || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
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
