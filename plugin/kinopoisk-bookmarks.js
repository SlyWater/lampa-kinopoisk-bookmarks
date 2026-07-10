(function () {
  'use strict';

  if (!window.Lampa || window.kinopoisk_bookmarks_ready) return;
  window.kinopoisk_bookmarks_ready = true;

  var PLUGIN_NAME = 'Кинопоиск Закладки';
  var STORAGE = {
    proxyUrl: 'kp_bookmarks_proxy_url',
    accessToken: 'kp_bookmarks_access_token',
    refreshToken: 'kp_bookmarks_refresh_token',
    tokenExpires: 'kp_bookmarks_token_expires',
    index: 'kp_bookmarks_index',
    ratings: 'kp_bookmarks_ratings',
    deviceId: 'kp_bookmarks_device_id'
  };

  var STATUSES = {
    watch_later: { title: 'Буду смотреть', remote: true },
    watching: { title: 'Смотрю', remote: false },
    postponed: { title: 'Отложено', remote: false }
  };

  var ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 4.75C6 3.78 6.78 3 7.75 3h8.5C17.22 3 18 3.78 18 4.75v15.5l-6-3.35-6 3.35V4.75Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

  function getProxyUrl() {
    return String(Lampa.Storage.get(STORAGE.proxyUrl, '') || '').replace(/\/+$/, '');
  }

  function getIndex() {
    return Lampa.Storage.get(STORAGE.index, {});
  }

  function setIndex(index) {
    Lampa.Storage.set(STORAGE.index, index || {});
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

      var html = $('<div><div class="about">Перейдите на https://ya.ru/device и введите код<br><br><b>' + data.user_code + '</b><br><br></div><div class="broadcast__device selector" style="text-align:center">Готово</div></div>');
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
            syncWatchLater();
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
    return ensureToken().then(function () {
      return api('/bookmarks/list', { auth: true });
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
      if (showNotice) Lampa.Noty.show('Закладки Кинопоиска синхронизированы');
      return index;
    }).catch(function (error) {
      if (showNotice) Lampa.Noty.show('Не удалось синхронизировать закладки');
      console.log('Kinopoisk Bookmarks', error);
    });
  }

  function resolveMovie(movie) {
    var ids = normalizeMovieIds(movie);
    var key = movieKey(ids);
    var ratingCache = getRatings();

    if (ids.kinopoiskId && ratingCache['kp:' + ids.kinopoiskId]) {
      return Promise.resolve({ ids: ids, ratings: ratingCache['kp:' + ids.kinopoiskId] });
    }

    if (!ids.kinopoiskId && !ids.tmdbId) return Promise.resolve({ ids: ids, ratings: null });

    var query = ids.kinopoiskId ? '?kinopoiskId=' + encodeURIComponent(ids.kinopoiskId) + '&kp=' + encodeURIComponent(ids.kinopoiskId) : '?tmdbId=' + encodeURIComponent(ids.tmdbId) + '&tmdb=' + encodeURIComponent(ids.tmdbId);

    return api('/ratings/resolve' + query).then(function (data) {
      var resolvedIds = data.ids || {};
      ids.kinopoiskId = ids.kinopoiskId || resolvedIds.kinopoiskId || resolvedIds.kinopoisk_id || resolvedIds.id_kp || '';
      ids.imdbId = ids.imdbId || resolvedIds.imdbId || '';
      var ratings = data.ratings || {};
      var ratingsKey = ids.kinopoiskId ? 'kp:' + ids.kinopoiskId : key;
      if (ratingsKey) {
        ratingCache[ratingsKey] = ratings;
        setRatings(ratingCache);
      }
      return { ids: ids, ratings: ratings };
    }).catch(function (error) {
      console.log('Kinopoisk Bookmarks', 'ratings resolve failed', error);
      return { ids: ids, ratings: null };
    });
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
          Lampa.Noty.show('Закладка удалена');
        });
      }

      delete index[key];
      setIndex(index);
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

  function injectStyle() {
    if ($('#kp-bookmarks-style').length) return;
    $('body').append('<style id="kp-bookmarks-style">.kp-rating-badges{position:absolute;left:.35em;right:.35em;bottom:.35em;display:flex;gap:.3em;z-index:4;pointer-events:none}.kp-rating-badge{background:rgba(0,0,0,.72);color:#fff;border-radius:.25em;padding:.18em .32em;font-size:.72em;line-height:1;font-weight:700}.kp-rating-badge span{color:#f0c14b;margin-right:.18em}.full-start-new .kp-rating-badges{position:static;margin:.65em 0 0;font-size:1.1em}.card,.card__view,.card__image,.full-start-new__poster{position:relative}</style>');
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
        default: '',
        placeholder: 'https://example.workers.dev'
      },
      field: {
        name: 'URL Worker',
        description: 'Например https://lampa-kp-bookmarks.example.workers.dev'
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
      param: { type: 'button', name: 'kp_bookmarks_clear' },
      field: { name: 'Очистить локальный кэш' },
      onChange: function () {
        setIndex({});
        setRatings({});
        Lampa.Noty.show('Кэш закладок очищен');
      }
    });
  }

  function startPlugin() {
    injectStyle();
    addSettings();

    Lampa.Listener.follow('full', function (event) {
      if (event.type !== 'complite' || !event.data || !event.data.movie) return;
      resolveMovie(event.data.movie).then(function (resolved) {
        renderFullButton(event.data.movie, resolved);
        renderFullRatings(resolved.ratings);
      });
    });

    Lampa.Listener.follow('activity', function () {
      setTimeout(patchVisibleCards, 700);
    });

    if (Lampa.Storage.get(STORAGE.accessToken, '')) syncWatchLater(false);
    setInterval(patchVisibleCards, 3000);
  }

  if (window.appready) startPlugin();
  else {
    Lampa.Listener.follow('app', function (event) {
      if (event.type === 'ready') startPlugin();
    });
  }
})();
