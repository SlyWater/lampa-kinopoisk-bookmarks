export const BOOKMARK_STATUSES = Object.freeze({
  WATCH_LATER: 'watch_later',
  WATCHING: 'watching',
  POSTPONED: 'postponed'
});

export const REMOTE_STATUSES = Object.freeze([BOOKMARK_STATUSES.WATCH_LATER]);

export function normalizeMovieIds(input = {}) {
  const movie = input.movie || input;
  const ids = {
    tmdbId: normalizeId(movie.tmdb_id || movie.tmdbId || movie.id_tmdb || movie.tmdb || (movie.source === 'tmdb' ? movie.id : undefined)),
    kinopoiskId: normalizeId(movie.kinopoisk_id || movie.kinopoiskId || movie.id_kp || movie.kp_id || movie.kp),
    imdbId: normalizeString(movie.imdb_id || movie.imdbId || movie.id_imdb || movie.imdb)
  };

  return ids;
}

export function movieStorageKey(input = {}) {
  const ids = normalizeMovieIds(input);
  if (ids.kinopoiskId) return `kp:${ids.kinopoiskId}`;
  if (ids.tmdbId) return `tmdb:${ids.tmdbId}`;
  if (ids.imdbId) return `imdb:${ids.imdbId}`;
  return '';
}

export function selectBookmarkStatus(currentStatus, nextStatus) {
  if (!nextStatus || nextStatus === 'remove') return null;
  if (!Object.values(BOOKMARK_STATUSES).includes(nextStatus)) {
    throw new Error(`Unsupported bookmark status: ${nextStatus}`);
  }
  return currentStatus === nextStatus ? null : nextStatus;
}

export function mergeBookmarkIndexes(localIndex = {}, remoteWatchLater = []) {
  const merged = { ...localIndex };
  const remoteKeys = new Set();

  remoteWatchLater.forEach((movie) => {
    const key = movieStorageKey(movie);
    if (!key) return;
    remoteKeys.add(key);
    merged[key] = {
      ...(merged[key] || {}),
      status: BOOKMARK_STATUSES.WATCH_LATER,
      remote: true,
      updatedAt: movie.updatedAt || new Date(0).toISOString()
    };
  });

  Object.keys(merged).forEach((key) => {
    const item = merged[key];
    if (item && item.status === BOOKMARK_STATUSES.WATCH_LATER && item.remote && !remoteKeys.has(key)) {
      delete merged[key];
    }
  });

  return merged;
}

export function formatRating(value) {
  const number = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number.toFixed(1);
}

export function formatRatingBadges(input = {}) {
  const kp = formatRating(input.kp ?? input.rating_kp ?? input.ratingKp);
  const imdb = formatRating(input.imdb ?? input.rating_imdb ?? input.ratingImdb);
  return [
    kp ? { source: 'KP', value: kp } : null,
    imdb ? { source: 'IMDb', value: imdb } : null
  ].filter(Boolean);
}

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return '';
  const stringValue = String(value).trim();
  return stringValue && stringValue !== '0' ? stringValue : '';
}

function normalizeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}
