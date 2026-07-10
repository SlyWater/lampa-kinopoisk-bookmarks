import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOKMARK_STATUSES,
  formatRatingBadges,
  mergeBookmarkIndexes,
  movieStorageKey,
  normalizeMovieIds,
  selectBookmarkStatus
} from '../shared/core.mjs';

test('normalizeMovieIds extracts ids from Lampa and Alloha shaped objects', () => {
  assert.deepEqual(normalizeMovieIds({
    id: 278,
    source: 'tmdb',
    kinopoisk_id: 326,
    id_imdb: 'tt0111161'
  }), {
    tmdbId: '278',
    kinopoiskId: '326',
    imdbId: 'tt0111161'
  });

  assert.equal(movieStorageKey({ id_kp: 535341, id_tmdb: 1399 }), 'kp:535341');
});

test('selectBookmarkStatus toggles selected status and rejects unsupported values', () => {
  assert.equal(selectBookmarkStatus(null, BOOKMARK_STATUSES.WATCH_LATER), BOOKMARK_STATUSES.WATCH_LATER);
  assert.equal(selectBookmarkStatus(BOOKMARK_STATUSES.WATCH_LATER, BOOKMARK_STATUSES.WATCH_LATER), null);
  assert.equal(selectBookmarkStatus(BOOKMARK_STATUSES.POSTPONED, 'remove'), null);
  assert.throws(() => selectBookmarkStatus(null, 'watched'), /Unsupported bookmark status/);
});

test('mergeBookmarkIndexes preserves local-only statuses and removes stale remote watch-later', () => {
  const local = {
    'kp:1': { status: BOOKMARK_STATUSES.WATCH_LATER, remote: true },
    'kp:2': { status: BOOKMARK_STATUSES.WATCHING, remote: false },
    'tmdb:3': { status: BOOKMARK_STATUSES.POSTPONED, remote: false }
  };

  const merged = mergeBookmarkIndexes(local, [
    { kinopoisk_id: 4, updatedAt: '2026-01-01T00:00:00.000Z' }
  ]);

  assert.equal(merged['kp:1'], undefined);
  assert.equal(merged['kp:2'].status, BOOKMARK_STATUSES.WATCHING);
  assert.equal(merged['tmdb:3'].status, BOOKMARK_STATUSES.POSTPONED);
  assert.equal(merged['kp:4'].status, BOOKMARK_STATUSES.WATCH_LATER);
  assert.equal(merged['kp:4'].remote, true);
});

test('formatRatingBadges formats only positive numeric ratings', () => {
  assert.deepEqual(formatRatingBadges({ rating_kp: 8.126, rating_imdb: '7,95' }), [
    { source: 'KP', value: '8.1' },
    { source: 'IMDb', value: '8.0' }
  ]);

  assert.deepEqual(formatRatingBadges({ rating_kp: 0, rating_imdb: null }), []);
});
