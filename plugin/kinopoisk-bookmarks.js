(function () {
  'use strict';

  if (!window.Lampa || window.kinopoisk_bookmarks_ready) return;
  window.kinopoisk_bookmarks_ready = true;

  var PLUGIN_NAME = 'Кинопоиск Закладки';
  var DEFAULT_PROXY_URL = 'https://lampa-kp.slywater.ru';
  var STORAGE = {
    proxyUrl: 'kp_bookmarks_proxy_url',
    accessToken: 'kp_bookmarks_access_token',
    refreshToken: 'kp_bookmarks_refresh_token',
    tokenExpires: 'kp_bookmarks_token_expires',
    index: 'kp_bookmarks_index',
    watchLaterItems: 'kp_bookmarks_watch_later_items',
    lastSync: 'kp_bookmarks_last_sync',
    ratings: 'kp_bookmarks_ratings',
    deviceId: 'kp_bookmarks_device_id'
  };

  var STATUSES = {
    watch_later: { title: 'Буду смотреть', remote: true },
    watching: { title: 'Смотрю', remote: false },
    postponed: { title: 'Отложено', remote: false }
  };

  var ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 4.75C6 3.78 6.78 3 7.75 3h8.5C17.22 3 18 3.78 18 4.75v15.5l-6-3.35-6 3.35V4.75Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  var TMDB_API_KEY = '4ef0d7355d9ffb5151e987764708ce96';
  var syncWatchLaterPromise = null;
  var syncWatchLaterStartedAt = 0;
  var syncProgressModalOpen = false;
  var syncProgressCloseTimer = null;

  function getProxyUrl() {
    return String(Lampa.Storage.get(STORAGE.proxyUrl, DEFAULT_PROXY_URL) || DEFAULT_PROXY_URL).replace(/\/+$/, '');
  }

  function getIndex() {
    return Lampa.Storage.get(STORAGE.index, {});
  }

  function setIndex(index) {
    Lampa.Storage.set(STORAGE.index, index || {});
  }

  function getWatchLaterItems() {
    return normalizeStoredArray(Lampa.Storage.get(STORAGE.watchLaterItems, []));
  }

  function setWatchLaterItems(items) {
    Lampa.Storage.set(STORAGE.watchLaterItems, dedupeWatchLaterItems(items || []));
    scheduleBookmarksFolderEntry();
  }

  function getLastSync() {
    return Lampa.Storage.get(STORAGE.lastSync, {});
  }

  function setLastSync(data) {
    Lampa.Storage.set(STORAGE.lastSync, {
      time: new Date().toISOString(),
      remoteCount: Number(data.remoteCount || 0),
      builtCount: Number(data.builtCount || 0),
      cacheCount: Number(data.cacheCount || 0),
      duplicateCount: Number(data.duplicateCount || 0),
      cacheHit: Boolean(data.cacheHit),
      inFlight: Boolean(data.inFlight),
      error: data.error || '',
      sample: data.sample || []
    });
  }

  function normalizeStoredArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        var parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        return [];
      }
    }
    return [];
  }

  function dedupeWatchLaterItems(items) {
    var seen = {};
    var result = [];

    normalizeStoredArray(items).forEach(function (item) {
      var key = watchLaterItemKey(item);
      if (!key || seen[key]) return;
      seen[key] = true;
      result.push(item);
    });

    return result;
  }

  function watchLaterItemKey(item) {
    if (!item) return '';
    var ids = normalizeMovieIds(item);
    if (ids.kinopoiskId) return 'kp:' + ids.kinopoiskId;
    if (ids.tmdbId) return (item.name && !item.title ? 'tv:' : 'movie:') + ids.tmdbId;
    if (ids.imdbId) return 'imdb:' + ids.imdbId;
    return '';
  }

  function getRatings() {
    return Lampa.Storage.get(STORAGE.ratings, {});
  }

  function setRatings(ratings) {
    Lampa.Storage.set(STORAGE.ratings, ratings || {});
  }

  function normalizeId(value) {
    if (value === null || value === undefined || value === '') return '';
    var stringValue = String(value).trim();
    return stringValue && stringValue !== '0' ? stringValue : '';
  }

  function normalizeMovieIds(movie) {
    movie = movie || {};
    return {
      tmdbId: normalizeId(movie.tmdb_id || movie.tmdbId || movie.id_tmdb || movie.tmdb || (movie.source === 'tmdb' ? movie.id : undefined) || movie.id),
      kinopoiskId: normalizeId(movie.kinopoisk_id || movie.kinopoiskId || movie.id_kp || movie.kp_id || movie.kp),
      imdbId: normalizeId(movie.imdb_id || movie.imdbId || movie.id_imdb || movie.imdb)
    };
  }

  function movieKey(ids) {
    if (ids.kinopoiskId) return 'kp:' + ids.kinopoiskId;
    if (ids.tmdbId) return 'tmdb:' + ids.tmdbId;
    if (ids.imdbId) return 'imdb:' + ids.imdbId;
    return '';
  }

  function statusTitle(status) {
    return STATUSES[status] ? STATUSES[status].title : 'Нет закладки';
  }

  function formatRating(value) {
    var number = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
    if (!Number.isFinite(number) || number <= 0) return '';
    return number.toFixed(1);
  }

  function api(path, options) {
    var proxy = getProxyUrl();
    if (!proxy) {
      Lampa.Noty.show('Укажите URL Worker-прокси в настройках');
      return Promise.reject(new Error('Proxy URL is not configured'));
    }

    options = options || {};
    var headers = options.headers || {};
    headers['content-type'] = 'application/json';

    if (options.auth) {
      var token = Lampa.Storage.get(STORAGE.accessToken, '');
      if (token) headers.authorization = 'Bearer ' + token;
    }

    return fetch(proxy + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = text ? JSON.parse(text) : {};
        if (!response.ok) {
          var error = new Error(data.message || data.error || 'Request failed');
          error.status = response.status;
          error.data = data;
          throw error;
        }
        return data;
      });
    });
  }

  function ensureToken() {
    var token = Lampa.Storage.get(STORAGE.accessToken, '');
    var refresh = Lampa.Storage.get(STORAGE.refreshToken, '');
    var expires = Number(Lampa.Storage.get(STORAGE.tokenExpires, 0));

    if (!token) return Promise.reject(new Error('Not authorized'));
    if (!refresh || expires - 60000 > Date.now()) return Promise.resolve(token);

    return api('/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refresh }
    }).then(saveToken);
  }

  function saveToken(data) {
    if (!data || !data.access_token) throw new Error('Token response does not contain access_token');
    Lampa.Storage.set(STORAGE.accessToken, data.access_token);
    if (data.refresh_token) Lampa.Storage.set(STORAGE.refreshToken, data.refresh_token);
    if (data.expires_in) Lampa.Storage.set(STORAGE.tokenExpires, Date.now() + Number(data.expires_in) * 1000);
    return data.access_token;
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (char) {
      var random = Math.random() * 16 | 0;
      var value = char === 'x' ? random : (random & 0x3 | 0x8);
      return value.toString(16);
    });
  }

  function authorize() {
    var deviceId = Lampa.Storage.get(STORAGE.deviceId, '') || uuid();
    Lampa.Storage.set(STORAGE.deviceId, deviceId);

    api('/auth/device', {
      method: 'POST',
      body: { device_id: deviceId }
    }).then(function (data) {
      if (!data.user_code || !data.device_code) throw new Error('Device code response is incomplete');

      var html = $('<div><div class="about kp-bookmarks-auth">Перейдите на https://ya.ru/device и введите код<b class="kp-bookmarks-auth-code">' + data.user_code + '</b><div class="kp-bookmarks-auth-qr"></div></div><div class="broadcast__device selector kp-bookmarks-auth-ready">Готово</div></div>');
      setTimeout(function () {
        if (Lampa.Utils && Lampa.Utils.qrcode) {
          Lampa.Utils.qrcode('https://ya.ru/device', html.find('.kp-bookmarks-auth-qr'));
        }
      }, 0);
      Lampa.Modal.open({
        title: 'Авторизация Кинопоиск',
        html: html,
        align: 'center',
        onBack: function () {
          Lampa.Modal.close();
        },
        onSelect: function () {
          api('/auth/token', {
            method: 'POST',
            body: { device_code: data.device_code }
          }).then(function (tokenData) {
            saveToken(tokenData);
            Lampa.Modal.close();
            Lampa.Noty.show('Авторизация Кинопоиска выполнена');
            syncWatchLater(true);
          }).catch(function (error) {
            Lampa.Noty.show('Не удалось получить токен Кинопоиска');
            console.log('Kinopoisk Bookmarks', error);
          });
        }
      });
    }).catch(function (error) {
      Lampa.Noty.show('Не удалось начать авторизацию');
      console.log('Kinopoisk Bookmarks', error);
    });
  }

  function syncWatchLater(showNotice) {
    if (syncWatchLaterPromise) {
      if (Date.now() - syncWatchLaterStartedAt > 20 * 60 * 1000) {
        syncWatchLaterPromise = null;
        syncWatchLaterStartedAt = 0;
      } else {
        if (showNotice) Lampa.Noty.show('Синхронизация уже идёт');
        return syncWatchLaterPromise;
      }
    }

    syncWatchLaterStartedAt = Date.now();
    var currentSync = ensureToken().then(function () {
      return showNotice ? runWatchLaterSyncJob() : api('/bookmarks/list', { auth: true });
    }).then(function (data) {
      var index = getIndex();
      var remoteKeys = {};

      (data.movies || []).forEach(function (movie) {
        var ids = normalizeMovieIds(movie);
        var key = movieKey(ids);
        if (!key) return;
        remoteKeys[key] = true;
        index[key] = {
          status: 'watch_later',
          remote: true,
          ids: ids,
          title: movie.title || '',
          updatedAt: movie.updatedAt || new Date().toISOString()
        };
      });

      Object.keys(index).forEach(function (key) {
        if (index[key].status === 'watch_later' && index[key].remote && !remoteKeys[key]) delete index[key];
      });

      setIndex(index);
      return buildWatchLaterItems(data, showNotice).then(function (items) {
        var uniqueItems = dedupeWatchLaterItems(items);
        var diagnostics = data.diagnostics || {};
        setWatchLaterItems(uniqueItems);
        setLastSync({
          remoteCount: (data.movies || []).length,
          builtCount: uniqueItems.length,
          cacheCount: uniqueItems.length,
          duplicateCount: Math.max(0, items.length - uniqueItems.length) + Number(diagnostics.duplicateMoviesCount || 0) + Number(diagnostics.duplicateCardsCount || 0),
          cacheHit: diagnostics.cacheHit,
          inFlight: diagnostics.inFlight,
          sample: uniqueItems.slice(0, 3).map(function (item) {
            return item.title || item.name || item.original_title || item.original_name || String(item.id);
          })
        });
        if (showNotice) Lampa.Noty.show('Буду смотреть обновлено: ' + uniqueItems.length);
        if (showNotice) closeSyncProgressModal(900);
        return index;
      });
    }).catch(function (error) {
      setLastSync({
        remoteCount: 0,
        builtCount: 0,
        cacheCount: getWatchLaterItems().length,
        error: error.message || String(error)
      });
      if (showNotice) updateSyncProgress({ status: 'error', message: error.message || String(error), error: error.message || String(error) });
      if (showNotice) closeSyncProgressModal(1800);
      if (showNotice) Lampa.Noty.show('Не удалось синхронизировать закладки');
      console.log('Kinopoisk Bookmarks', error);
    });

    syncWatchLaterPromise = currentSync.then(function (result) {
      syncWatchLaterPromise = null;
      syncWatchLaterStartedAt = 0;
      return result;
    }, function (error) {
      syncWatchLaterPromise = null;
      syncWatchLaterStartedAt = 0;
      throw error;
    });

    return syncWatchLaterPromise;
  }

  function runWatchLaterSyncJob() {
    openSyncProgressModal();
    updateSyncProgress({ message: 'Запускаю синхронизацию', processed: 0, total: 0, percent: 0 });

    return api('/bookmarks/sync/start?refresh=1', { method: 'POST', auth: true }).then(function (start) {
      if (start.result) {
        updateSyncProgress(start.progress || { status: 'done', percent: 100, message: 'Синхронизация завершена' });
        return start.result;
      }
      if (!start.jobId) return api('/bookmarks/list?refresh=1', { auth: true });
      updateSyncProgress(start.progress || start);
      return pollWatchLaterSyncJob(start.jobId);
    }).catch(function (error) {
      if (error && error.status === 404) return api('/bookmarks/list?refresh=1', { auth: true });
      throw error;
    });
  }

  function pollWatchLaterSyncJob(jobId) {
    return new Promise(function (resolve, reject) {
      function tick() {
        api('/bookmarks/sync/status?id=' + encodeURIComponent(jobId), { auth: true }).then(function (status) {
          updateSyncProgress(status);
          if (status.status === 'done' && status.result) {
            resolve(status.result);
            return;
          }
          if (status.status === 'error') {
            reject(new Error(status.error || status.message || 'Sync failed'));
            return;
          }
          setTimeout(tick, 900);
        }).catch(reject);
      }

      setTimeout(tick, 450);
    });
  }

  function buildWatchLaterItems(data, showNotice) {
    var movies = data.movies || [];
    var backendCards = data.cards || [];
    if (backendCards.length) return Promise.resolve(backendCards);

    var queue = Promise.resolve();
    var items = [];

    movies.forEach(function (movie) {
      queue = queue.then(function () {
        return resolveMovieStrict(movie).then(function (resolved) {
          return fetchTmdbCardStrict(resolved.ids, resolved.meta, movie);
        }).then(function (card) {
          if (card && card.id) items.push(card);
        }).catch(function (error) {
          console.log('Kinopoisk Bookmarks', 'watch later item build failed', movie, error);
        });
      });
    });

    return queue.then(function () {
      if (showNotice && movies.length) {
        console.log('Kinopoisk Bookmarks', 'Built Kinopoisk watch later:', items.length, 'of', movies.length);
      }
      return items;
    });
  }

  function resolveMovie(movie) {
    var ids = normalizeMovieIds(movie);
    var key = movieKey(ids);
    var ratingCache = getRatings();

    if (ids.kinopoiskId && ids.tmdbId && ratingCache['kp:' + ids.kinopoiskId]) {
      return Promise.resolve({ ids: ids, ratings: ratingCache['kp:' + ids.kinopoiskId] });
    }

    if (!ids.kinopoiskId && !ids.tmdbId && !movieTitle(movie)) return Promise.resolve({ ids: ids, ratings: null, meta: {} });

    var query = '';
    if (ids.kinopoiskId) query = '?kinopoiskId=' + encodeURIComponent(ids.kinopoiskId) + '&kp=' + encodeURIComponent(ids.kinopoiskId);
    else if (ids.tmdbId) query = '?tmdbId=' + encodeURIComponent(ids.tmdbId) + '&tmdb=' + encodeURIComponent(ids.tmdbId);
    else {
      query = '?name=' + encodeURIComponent(movieTitle(movie));
      var initialYear = movieYear(movie);
      if (initialYear) query += '&year=' + encodeURIComponent(initialYear);
    }

    return resolveMovieByQuery(query, ids, key).then(function (resolved) {
      if (resolved.ids.kinopoiskId || !movieTitle(movie)) return resolved;

      var fallbackQuery = '?name=' + encodeURIComponent(movieTitle(movie));
      var year = movieYear(movie);
      if (year) fallbackQuery += '&year=' + encodeURIComponent(year);
      return resolveMovieByQuery(fallbackQuery, ids, key);
    }).catch(function (error) {
      console.log('Kinopoisk Bookmarks', 'ratings resolve failed', error);
      return { ids: ids, ratings: null, meta: {} };
    });
  }

  function resolveMovieByQuery(query, ids, key) {
    return api('/ratings/resolve' + query).then(function (data) {
      var resolvedIds = data.ids || {};
      ids.kinopoiskId = ids.kinopoiskId || resolvedIds.kinopoiskId || resolvedIds.kinopoisk_id || resolvedIds.id_kp || '';
      ids.tmdbId = ids.tmdbId || resolvedIds.tmdbId || resolvedIds.tmdb_id || resolvedIds.id_tmdb || '';
      ids.imdbId = ids.imdbId || resolvedIds.imdbId || '';
      var ratings = data.ratings || {};
      var ratingsKey = ids.kinopoiskId ? 'kp:' + ids.kinopoiskId : key;
      if (ratingsKey) {
        ratingCache[ratingsKey] = ratings;
        setRatings(ratingCache);
      }
      return { ids: ids, ratings: ratings, meta: data.movie || {} };
    });
  }

  function resolveMovieStrict(movie) {
    var ids = normalizeMovieIds(movie);
    if (!ids.kinopoiskId && !ids.tmdbId) return Promise.resolve({ ids: ids, ratings: null, meta: normalizeMovieMeta(movie) });

    var query = ids.kinopoiskId ? '?kp=' + encodeURIComponent(ids.kinopoiskId) : '?tmdb=' + encodeURIComponent(ids.tmdbId);
    return resolveMovieByQuery(query, ids, movieKey(ids)).then(function (resolved) {
      resolved.meta = mergeMeta(normalizeMovieMeta(movie), resolved.meta);
      return resolved;
    }).catch(function (error) {
      console.log('Kinopoisk Bookmarks', 'strict resolve failed', movie, error);
      return { ids: ids, ratings: null, meta: normalizeMovieMeta(movie) };
    });
  }

  function movieTitle(movie) {
    return movie && (movie.title || movie.name || movie.original_title || movie.original_name || '');
  }

  function movieYear(movie) {
    var date = movie && (movie.release_date || movie.first_air_date || movie.year || movie.productionYear || '');
    return String(date).slice(0, 4);
  }

  function fetchTmdbCard(ids, meta, sourceMovie) {
    if (!ids.tmdbId) return Promise.resolve(null);

    var type = (meta && meta.type) || (sourceMovie && sourceMovie.name ? 'tv' : 'movie');
    var domain = (Lampa.Manifest && Lampa.Manifest.cub_domain) ? Lampa.Manifest.cub_domain : 'cub.red';
    var url = Lampa.Utils.protocol() + 'tmdb.' + domain + '/3/' + type + '/' + encodeURIComponent(ids.tmdbId) + '?api_key=' + TMDB_API_KEY + '&language=ru';

    return fetch(url).then(function (response) {
      if (!response.ok) throw new Error('TMDB request failed: ' + response.status);
      return response.json();
    }).then(function (card) {
      card.source = 'tmdb';
      card.kinopoisk_id = ids.kinopoiskId;
      return card;
    }).catch(function (error) {
      console.log('Kinopoisk Bookmarks', 'tmdb card fetch failed', ids, error);
      return buildMinimalFavoriteCard(ids, meta, sourceMovie, type);
    });
  }

  function fetchTmdbCardStrict(ids, meta, sourceMovie) {
    if (!ids.tmdbId) return Promise.resolve(buildMinimalFavoriteCard(ids, meta, sourceMovie, meta && meta.type));
    return fetchTmdbCard(ids, meta, sourceMovie);
  }

  function buildMinimalFavoriteCard(ids, meta, sourceMovie, type) {
    var id = Number(ids.tmdbId || ids.kinopoiskId);
    if (!id) return null;

    meta = mergeMeta(normalizeMovieMeta(sourceMovie), meta);
    type = type || (meta && meta.type) || 'movie';

    var title = (meta && meta.title) || '';
    var original = (meta && meta.original_title) || title;
    var card = {
      id: id,
      source: 'tmdb',
      kinopoisk_id: ids.kinopoiskId,
      vote_average: 0,
      overview: (meta && meta.description) || '',
      poster_path: (meta && meta.poster) || '',
      poster: (meta && meta.poster) || '',
      img: (meta && meta.poster) || '',
      release_date: meta && meta.year ? String(meta.year) + '-01-01' : ''
    };

    if (type === 'tv') {
      card.name = title || original;
      card.original_name = original;
      card.first_air_date = card.release_date;
    } else {
      card.title = title || original;
      card.original_title = original;
    }

    return card;
  }

  function normalizeMovieMeta(movie) {
    movie = movie || {};
    return {
      type: movie.name && !movie.title ? 'tv' : (movie.type || 'movie'),
      title: movie.title || movie.name || movie.original_title || movie.original_name || '',
      original_title: movie.original_title || movie.original_name || movie.title || movie.name || '',
      year: movie.year || movie.productionYear || movieYear(movie) || null,
      poster: movie.poster || movie.poster_path || '',
      description: movie.description || movie.overview || ''
    };
  }

  function mergeMeta(primary, fallback) {
    primary = primary || {};
    fallback = fallback || {};
    return {
      type: primary.type || fallback.type || 'movie',
      title: primary.title || fallback.title || '',
      original_title: primary.original_title || fallback.original_title || '',
      year: primary.year || fallback.year || null,
      poster: primary.poster || fallback.poster || '',
      description: primary.description || fallback.description || ''
    };
  }

  function upsertWatchLaterItem(card) {
    if (!card || !card.id) return;
    var items = getWatchLaterItems().filter(function (item) {
      return watchLaterItemKey(item) !== watchLaterItemKey(card);
    });
    items.unshift(card);
    setWatchLaterItems(items);
  }

  function removeWatchLaterItem(movie) {
    if (!movie || !movie.id) return;
    setWatchLaterItems(getWatchLaterItems().filter(function (item) {
      return String(item.id) !== String(movie.id);
    }));
  }

  function applyStatus(key, ids, movie, nextStatus) {
    var index = getIndex();

    if (!nextStatus) {
      if (index[key] && index[key].status === 'watch_later' && index[key].remote && ids.kinopoiskId) {
        return ensureToken().then(function () {
          return api('/bookmarks/watch-later/remove', {
            method: 'POST',
            auth: true,
            body: { kinopoisk_id: ids.kinopoiskId }
          });
        }).then(function () {
          delete index[key];
          setIndex(index);
          removeWatchLaterItem(movie);
          Lampa.Noty.show('Закладка удалена');
        });
      }

      delete index[key];
      setIndex(index);
      removeWatchLaterItem(movie);
      Lampa.Noty.show('Закладка удалена');
      return Promise.resolve();
    }

    if (nextStatus === 'watch_later') {
      if (!ids.kinopoiskId) {
        Lampa.Noty.show('Не найден id фильма на Кинопоиске');
        return Promise.resolve();
      }

      return ensureToken().then(function () {
        return api('/bookmarks/watch-later/set', {
          method: 'POST',
          auth: true,
          body: { kinopoisk_id: ids.kinopoiskId }
        });
      }).then(function () {
        index[key] = buildIndexItem(ids, movie, nextStatus, true);
        setIndex(index);
        return fetchTmdbCard(ids, {}, movie);
      }).then(function (card) {
        upsertWatchLaterItem(card);
        Lampa.Noty.show('Добавлено в Буду смотреть');
      });
    }

    index[key] = buildIndexItem(ids, movie, nextStatus, false);
    setIndex(index);
    Lampa.Noty.show('Локальный статус: ' + statusTitle(nextStatus));
    return Promise.resolve();
  }

  function buildIndexItem(ids, movie, status, remote) {
    return {
      status: status,
      remote: remote,
      ids: ids,
      title: movie.title || movie.name || movie.original_title || movie.original_name || '',
      updatedAt: new Date().toISOString()
    };
  }

  function openStatusMenu(movie, resolved) {
    var ids = resolved.ids;
    var key = movieKey(ids);
    if (!key) {
      Lampa.Noty.show('Не удалось определить идентификатор фильма');
      return;
    }

    var current = getIndex()[key] || {};
    var items = [
      { title: 'Буду смотреть', status: 'watch_later', selected: current.status === 'watch_later' },
      { title: 'Смотрю (локально)', status: 'watching', selected: current.status === 'watching' },
      { title: 'Отложено (локально)', status: 'postponed', selected: current.status === 'postponed' },
      { title: 'Убрать', status: null }
    ];

    items.forEach(function (item) {
      item.template = 'selectbox_icon';
      item.icon = '';
    });

    Lampa.Select.show({
      title: 'Закладка',
      items: items,
      onSelect: function (item) {
        applyStatus(key, ids, movie, item.status).then(function () {
          renderFullButton(movie, resolved);
        }).catch(function (error) {
          Lampa.Noty.show('Не удалось изменить закладку');
          console.log('Kinopoisk Bookmarks', error);
        });
      },
      onBack: function () {
        Lampa.Controller.toggle('full_start');
      }
    });
  }

  function renderFullButton(movie, resolved) {
    var ids = resolved.ids;
    var key = movieKey(ids);
    var index = getIndex();
    var current = key ? index[key] : null;
    var label = current && current.status ? statusTitle(current.status) : 'Закладка';

    $('.button--kp-bookmark').remove();
    $('.full-start-new__buttons').append('<div class="full-start__button selector button--kp-bookmark">' + ICON + '<span>' + label + '</span></div>');
    $('.button--kp-bookmark').on('hover:enter', function () {
      openStatusMenu(movie, resolved);
    });
  }

  function openSyncProgressModal() {
    if (syncProgressCloseTimer) clearTimeout(syncProgressCloseTimer);
    syncProgressCloseTimer = null;
    syncProgressModalOpen = true;

    var html = $('<div class="about kp-bookmarks-sync-progress"><div class="kp-bookmarks-sync-progress-title">Подготовка</div><div class="kp-bookmarks-sync-progress-bar"><div class="kp-bookmarks-sync-progress-fill"></div></div><div class="kp-bookmarks-sync-progress-numbers">0%</div><div class="kp-bookmarks-sync-progress-details"></div></div>');
    Lampa.Modal.open({
      title: 'Синхронизация Буду смотреть',
      html: html,
      size: 'medium',
      onBack: function () {
        syncProgressModalOpen = false;
        Lampa.Modal.close();
      }
    });
  }

  function updateSyncProgress(status) {
    if (!syncProgressModalOpen) return;
    status = status || {};
    var total = Number(status.total || 0);
    var processed = Number(status.processed || 0);
    var percent = Number(status.percent || (total ? Math.round(processed / total * 100) : 0));
    if (status.status === 'done') percent = 100;
    if (!Number.isFinite(percent)) percent = 0;
    percent = Math.max(0, Math.min(100, percent));

    $('.kp-bookmarks-sync-progress-fill').css('width', percent + '%');
    $('.kp-bookmarks-sync-progress-title').text(status.message || 'Синхронизация');
    $('.kp-bookmarks-sync-progress-numbers').text(percent + '%');

    var details = [];
    if (total) details.push('Обработано: ' + processed + ' из ' + total);
    if (status.cardsCount !== undefined) details.push('Карточек: ' + Number(status.cardsCount || 0));
    if (status.fallbackCardsCount !== undefined) details.push('Fallback: ' + Number(status.fallbackCardsCount || 0));
    if (status.unresolvedCount !== undefined) details.push('Не сопоставлено: ' + Number(status.unresolvedCount || 0));
    if (status.error) details.push('Ошибка: ' + status.error);
    $('.kp-bookmarks-sync-progress-details').html(escapeHtml(details.join('\n')));
  }

  function closeSyncProgressModal(delay) {
    if (syncProgressCloseTimer) clearTimeout(syncProgressCloseTimer);
    syncProgressCloseTimer = setTimeout(function () {
      if (!syncProgressModalOpen) return;
      syncProgressModalOpen = false;
      Lampa.Modal.close();
    }, delay || 0);
  }

  function injectStyle() {
    if ($('#kp-bookmarks-style').length) return;
    $('body').append('<style id="kp-bookmarks-style">.kp-rating-badges{position:absolute;left:.35em;right:.35em;bottom:.35em;display:flex;gap:.3em;z-index:4;pointer-events:none}.kp-rating-badge{background:rgba(0,0,0,.72);color:#fff;border-radius:.25em;padding:.18em .32em;font-size:.72em;line-height:1;font-weight:700}.kp-rating-badge span{color:#f0c14b;margin-right:.18em}.full-start-new .kp-rating-badges{position:static;margin:.65em 0 0;font-size:1.1em}.card,.card__view,.card__image,.full-start-new__poster{position:relative}.kp-bookmarks-auth{text-align:center}.kp-bookmarks-auth-qr{display:inline-flex;align-items:center;justify-content:center;width:9em;height:9em;max-width:38vw;max-height:38vw;margin:.75em auto .5em;background:#fff;border-radius:.45em;color:#000;overflow:hidden}.kp-bookmarks-auth-qr svg{width:100%;height:100%;display:block}.kp-bookmarks-auth-code{display:block;margin:.55em auto .25em;font-size:1.55em;line-height:1.2;letter-spacing:.08em}.kp-bookmarks-auth-ready{text-align:center}.kp-bookmarks-sync-progress{text-align:left}.kp-bookmarks-sync-progress-title{font-size:1.05em;margin-bottom:.8em}.kp-bookmarks-sync-progress-bar{height:.55em;background:rgba(255,255,255,.18);border-radius:.35em;overflow:hidden;margin-bottom:.55em}.kp-bookmarks-sync-progress-fill{width:0;height:100%;background:#f0c14b;border-radius:.35em;transition:width .25s ease}.kp-bookmarks-sync-progress-numbers{font-size:.95em;margin-bottom:.6em}.kp-bookmarks-sync-progress-details{white-space:pre-wrap;opacity:.82;font-size:.86em;line-height:1.35}.kp-bookmarks-folder-empty{display:flex;align-items:center;justify-content:center;height:100%;opacity:.72}.kp-bookmarks-folder-empty svg{width:42%;height:42%}</style>');
  }

  function renderRatingBadges(container, ratings) {
    if (!container || !ratings) return;
    var kp = formatRating(ratings.kp || ratings.rating_kp);
    var imdb = formatRating(ratings.imdb || ratings.rating_imdb);
    if (!kp && !imdb) return;

    var html = '<div class="kp-rating-badges">';
    if (kp) html += '<div class="kp-rating-badge"><span>KP</span>' + kp + '</div>';
    if (imdb) html += '<div class="kp-rating-badge"><span>IMDb</span>' + imdb + '</div>';
    html += '</div>';

    container.find('.kp-rating-badges').remove();
    container.append(html);
  }

  function renderFullRatings(ratings) {
    var container = $('.full-start-new__poster, .full-start__poster').eq(0);
    renderRatingBadges(container, ratings);
  }

  function patchVisibleCards() {
    $('.card').each(function () {
      var card = $(this);
      if (card.data('kp-badges')) return;
      var source = card.data('card') || card.data('movie') || card.data('item');
      if (!source) return;
      card.data('kp-badges', true);
      resolveMovie(source).then(function (resolved) {
        renderRatingBadges(card.find('.card__view').eq(0).length ? card.find('.card__view').eq(0) : card, resolved.ratings);
      });
    });
  }

  function addSettings() {
    Lampa.SettingsApi.addComponent({
      component: 'kp_bookmarks',
      icon: ICON,
      name: PLUGIN_NAME
    });

    Lampa.SettingsApi.addParam({
      component: 'kp_bookmarks',
      param: { type: 'title' },
      field: { name: 'Прокси' }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp_bookmarks',
      param: {
        name: STORAGE.proxyUrl,
        type: 'input',
        values: '',
        default: DEFAULT_PROXY_URL,
        placeholder: DEFAULT_PROXY_URL
      },
      field: {
        name: 'URL Worker',
        description: 'По умолчанию используется ' + DEFAULT_PROXY_URL
      }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp_bookmarks',
      param: { type: 'title' },
      field: { name: 'Аккаунт' }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp_bookmarks',
      param: { type: 'button', name: 'kp_bookmarks_auth' },
      field: { name: Lampa.Storage.get(STORAGE.accessToken, '') ? 'Авторизовано' : 'Авторизоваться' },
      onChange: authorize
    });

    Lampa.SettingsApi.addParam({
      component: 'kp_bookmarks',
      param: { type: 'button', name: 'kp_bookmarks_sync' },
      field: { name: 'Синхронизировать Буду смотреть' },
      onChange: function () {
        syncWatchLater(true);
      }
    });

    Lampa.SettingsApi.addParam({
      component: 'kp_bookmarks',
      param: { type: 'button', name: 'kp_bookmarks_open_watch_later' },
      field: { name: 'Открыть Буду смотреть' },
      onChange: openWatchLater
    });

    Lampa.SettingsApi.addParam({
      component: 'kp_bookmarks',
      param: { type: 'button', name: 'kp_bookmarks_diagnostics' },
      field: { name: 'Диагностика' },
      onChange: showDiagnostics
    });

    Lampa.SettingsApi.addParam({
      component: 'kp_bookmarks',
      param: { type: 'button', name: 'kp_bookmarks_clear' },
      field: { name: 'Очистить локальный кэш' },
      onChange: function () {
        setIndex({});
        setRatings({});
        setWatchLaterItems([]);
        Lampa.Storage.set(STORAGE.lastSync, {});
        Lampa.Noty.show('Кэш закладок очищен');
      }
    });
  }

  function openWatchLater() {
    Lampa.Activity.push({
      url: '',
      title: 'Буду смотреть',
      component: 'kp_bookmarks_watch_later',
      page: 1
    });
  }

  function showDiagnostics() {
    var auth = Lampa.Storage.get(STORAGE.accessToken, '') ? 'да' : 'нет';
    var last = getLastSync();
    var cache = getWatchLaterItems();
    var lines = [
      'Proxy: ' + getProxyUrl(),
      'Авторизация: ' + auth,
      'Кэш Буду смотреть: ' + cache.length,
      'Последняя синхронизация: ' + (last.time || 'нет'),
      'Фильмов от Кинопоиска: ' + (last.remoteCount || 0),
      'Собрано карточек Lampa: ' + (last.builtCount || 0),
      'Удалено дублей: ' + (last.duplicateCount || 0)
    ];

    if (last.sample && last.sample.length) lines.push('Примеры: ' + last.sample.join(', '));
    if (last.error) lines.push('Ошибка: ' + last.error);

    ensureToken().then(function () {
      return api('/bookmarks/list?refresh=1', { auth: true });
    }).then(function (data) {
      var diagnostics = data.diagnostics || {};
      lines.push('Проверка сейчас: Кинопоиск вернул ' + ((data.movies || []).length) + ' фильмов');
      if (diagnostics.source) lines.push('Источник списка: ' + diagnostics.source);
      lines.push('hasUserData: ' + Boolean(diagnostics.hasUserData));
      lines.push('hasPlannedToWatch: ' + Boolean(diagnostics.hasPlannedToWatch));
      lines.push('total: ' + (diagnostics.total === null || diagnostics.total === undefined ? 'null' : diagnostics.total));
      lines.push('rawItemsCount: ' + (diagnostics.rawItemsCount === null || diagnostics.rawItemsCount === undefined ? 'null' : diagnostics.rawItemsCount));
      if (diagnostics.pagination) {
        lines.push('paginationSupported: ' + Boolean(diagnostics.pagination.supported));
        if (diagnostics.pagination.param) lines.push('paginationParam: ' + diagnostics.pagination.param);
        lines.push('paginationPages: ' + (diagnostics.pagination.uniquePages || 0) + '/' + (diagnostics.pagination.requestedPages || 0));
      }
      if (diagnostics.cardsCount !== undefined) lines.push('backend cardsCount: ' + diagnostics.cardsCount);
      if (diagnostics.fallbackCardsCount !== undefined) lines.push('backend fallbackCardsCount: ' + diagnostics.fallbackCardsCount);
      if (diagnostics.duplicateMoviesCount !== undefined) lines.push('backend duplicateMoviesCount: ' + diagnostics.duplicateMoviesCount);
      if (diagnostics.duplicateCardsCount !== undefined) lines.push('backend duplicateCardsCount: ' + diagnostics.duplicateCardsCount);
      if (diagnostics.cacheHit !== undefined) lines.push('backend cacheHit: ' + diagnostics.cacheHit);
      if (diagnostics.inFlight !== undefined) lines.push('backend inFlight: ' + diagnostics.inFlight);
      if (diagnostics.unresolvedCount !== undefined) lines.push('backend unresolvedCount: ' + diagnostics.unresolvedCount);
      if (diagnostics.userDataKeys && diagnostics.userDataKeys.length) lines.push('userDataKeys: ' + diagnostics.userDataKeys.join(', '));
      if (diagnostics.unresolved && diagnostics.unresolved.length) {
        lines.push('Не сопоставлены: ' + diagnostics.unresolved.slice(0, 5).map(function (item) {
          return item.title || item.kinopoisk_id;
        }).join(', '));
      }
      if (diagnostics.topLevelError) lines.push('topLevelError: ' + diagnostics.topLevelError);
      if (diagnostics.upstreamStatus) lines.push('upstreamStatus: ' + diagnostics.upstreamStatus);
      if (diagnostics.errors && diagnostics.errors.length) {
        lines.push('GraphQL errors: ' + diagnostics.errors.map(function (error) {
          return error.message;
        }).join(' | '));
      }
      openDiagnosticsModal(lines);
    }).catch(function (error) {
      lines.push('Проверка сейчас: ошибка ' + (error.message || String(error)));
      openDiagnosticsModal(lines);
    });
  }

  function openDiagnosticsModal(lines) {
    Lampa.Modal.open({
      title: 'Диагностика',
      html: $('<div class="about" style="text-align:left;white-space:pre-wrap">' + escapeHtml(lines.join('\n')) + '</div>'),
      size: 'medium',
      onBack: function () {
        Lampa.Modal.close();
        Lampa.Controller.toggle('settings_component');
      }
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char];
    });
  }

  function addMenuItem() {
    if ($('.menu .menu__list .kp-bookmarks-menu').length) return;
    var list = $('.menu .menu__list').eq(0);
    if (!list.length) return;

    var button = $('<li class="menu__item selector kp-bookmarks-menu"><div class="menu__ico">' + ICON + '</div><div class="menu__text">Буду смотреть</div></li>');
    button.on('hover:enter', openWatchLater);
    list.append(button);
  }

  function addBookmarksFolderEntry() {
    if ($('.kp-bookmarks-folder-entry').length) {
      updateBookmarksFolderEntry($('.kp-bookmarks-folder-entry'));
      return;
    }

    var source = $('.bookmarks-folder').filter(function () {
      var title = $(this).find('.bookmarks-folder__title').text().trim();
      return /^(Позже|Later)$/i.test(title);
    }).eq(0);

    if (!source.length) source = $('.bookmarks-folder').eq(0);
    if (!source.length) return;

    var folder = source.clone(false);
    folder.addClass('kp-bookmarks-folder-entry');
    folder.removeClass('focus hover');
    folder.removeAttr('data-json data-id data-index');
    updateBookmarksFolderEntry(folder);
    folder.on('hover:enter click', openWatchLater);
    source.after(folder);
  }

  function updateBookmarksFolderEntry(folder) {
    var items = getWatchLaterItems();
    folder.find('.bookmarks-folder__title').text('Буду смотреть');
    folder.find('.bookmarks-folder__num').text(items.length);
    var body = folder.find('.bookmarks-folder__body');
    body.empty();

    items.filter(function (item) {
      return item.poster_path || item.poster || item.img;
    }).slice(0, 3).forEach(function (item, index) {
      body.append('<img class="card__img i-' + index + '" src="' + escapeHtml(posterUrl(item)) + '">');
    });

    if (!body.children().length) body.append('<div class="kp-bookmarks-folder-empty">' + ICON + '</div>');
  }

  function posterUrl(item) {
    var poster = item.poster_path || item.poster || item.img || '';
    if (!poster) return './img/img_load.svg';
    if (poster.indexOf('http') === 0) return poster;
    if (poster.indexOf('//') === 0) return 'https:' + poster;
    if (poster.charAt(0) === '/') return 'https://image.tmdb.org/t/p/w342' + poster;
    return poster;
  }

  function scheduleBookmarksFolderEntry() {
    var attempts = 0;
    var timer = setInterval(function () {
      addBookmarksFolderEntry();
      attempts++;
      if ($('.kp-bookmarks-folder-entry').length || attempts >= 12) clearInterval(timer);
    }, 500);
  }

  function scheduleMenuItem() {
    var attempts = 0;
    var timer = setInterval(function () {
      addMenuItem();
      attempts++;
      if ($('.menu .menu__list .kp-bookmarks-menu').length || attempts >= 20) clearInterval(timer);
    }, 500);
  }

  function component(object) {
    var comp = new Lampa.InteractionCategory(object);
    comp.create = function () {
      watchLaterApi(object, this.build.bind(this), this.empty.bind(this));
    };
    comp.nextPageReuest = function (object, resolve, reject) {
      watchLaterApi(object, resolve.bind(comp), reject.bind(comp));
    };
    return comp;
  }

  function watchLaterApi(params, oncomplete, onerror) {
    var items = getWatchLaterItems();
    oncomplete({
      secuses: true,
      page: 1,
      results: items
    });
  }

  function startPlugin() {
    injectStyle();
    addSettings();
    Lampa.Component.add('kp_bookmarks_watch_later', component);

    Lampa.Listener.follow('full', function (event) {
      if (event.type !== 'complite' || !event.data || !event.data.movie) return;
      resolveMovie(event.data.movie).then(function (resolved) {
        renderFullButton(event.data.movie, resolved);
        renderFullRatings(resolved.ratings);
      });
    });

    Lampa.Listener.follow('activity', function () {
      setTimeout(patchVisibleCards, 700);
      scheduleBookmarksFolderEntry();
    });

    if (window.appready) scheduleMenuItem();
    else {
      Lampa.Listener.follow('app', function (event) {
        if (event.type === 'ready') {
          scheduleMenuItem();
          scheduleBookmarksFolderEntry();
        }
      });
    }
    scheduleBookmarksFolderEntry();

    Lampa.Listener.follow('activity', function () {
      scheduleMenuItem();
      scheduleBookmarksFolderEntry();
    });

    setInterval(patchVisibleCards, 3000);
  }

  if (window.appready) startPlugin();
  else {
    Lampa.Listener.follow('app', function (event) {
      if (event.type === 'ready') startPlugin();
    });
  }
})();
