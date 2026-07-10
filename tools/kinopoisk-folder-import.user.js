// ==UserScript==
// @name         Lampa KP Import
// @namespace    https://github.com/SlyWater/lampa-kinopoisk-bookmarks
// @version      0.1.0
// @description  Export Kinopoisk folder items into Lampa Kinopoisk Bookmarks backend.
// @match        https://www.kinopoisk.ru/mykp/folders/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_PROXY = 'https://lampa-kp.slywater.ru';
  const MAX_PAGES = 20;

  window.addEventListener('load', addImportButton, false);

  function addImportButton() {
    if (document.getElementById('lampa-kp-import-button')) return;

    const button = document.createElement('button');
    button.id = 'lampa-kp-import-button';
    button.textContent = 'Lampa KP Import';
    button.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'z-index:2147483647',
      'padding:12px 16px',
      'border:0',
      'border-radius:8px',
      'background:#f5c518',
      'color:#111',
      'font:600 14px Arial,sans-serif',
      'box-shadow:0 4px 18px rgba(0,0,0,.28)',
      'cursor:pointer'
    ].join(';');
    button.addEventListener('click', runImport);
    document.body.appendChild(button);
  }

  async function runImport() {
    const code = normalizeCode(window.prompt('Код импорта из Lampa'));
    if (!code) return;

    const proxy = String(window.prompt('URL backend', DEFAULT_PROXY) || DEFAULT_PROXY).replace(/\/+$/, '');
    updateButton('Собираю...');

    try {
      const movies = await collectAllMovies();
      if (!movies.length) throw new Error('Не нашёл фильмы на странице папки');

      updateButton('Отправляю ' + movies.length);
      const response = await fetch(proxy + '/bookmarks/import/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code,
          movies,
          sourceUrl: location.href,
          title: document.title
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));

      updateButton('Готово: ' + data.receivedCount);
      window.alert('Импорт отправлен: ' + data.receivedCount + '. Вернись в Lampa и нажми OK.');
    } catch (error) {
      updateButton('Ошибка');
      console.error('Lampa KP Import', error);
      window.alert('Ошибка импорта: ' + (error.message || String(error)));
    }
  }

  async function collectAllMovies() {
    const collected = [];
    const seen = new Set();
    const current = parseMovies(document, location.href);
    pushUnique(collected, seen, current);

    const linkedPages = discoverLinkedPageUrls(document);
    for (const url of linkedPages) {
      if (samePage(url, location.href)) continue;
      const pageMovies = await fetchPageMovies(url);
      pushUnique(collected, seen, pageMovies);
      updateButton('Собрано ' + collected.length);
    }

    let misses = 0;
    for (let page = 2; page <= MAX_PAGES && misses < 2; page += 1) {
      const url = pageUrl(location.href, page);
      if (linkedPages.some((linked) => samePage(linked, url))) continue;
      const before = collected.length;
      const pageMovies = await fetchPageMovies(url);
      pushUnique(collected, seen, pageMovies);
      updateButton('Собрано ' + collected.length);
      misses = collected.length === before ? misses + 1 : 0;
    }

    return collected;
  }

  async function fetchPageMovies(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) return [];
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return parseMovies(doc, url);
  }

  function parseMovies(doc, sourceUrl) {
    const nodes = Array.from(doc.querySelectorAll('#itemList li[data-id], li[data-id][class*="item"]'));
    return nodes.map((node) => parseMovieNode(node, sourceUrl)).filter(Boolean);
  }

  function parseMovieNode(node, sourceUrl) {
    const id = String(node.getAttribute('data-id') || '').replace(/\D+/g, '');
    if (!id) return null;

    const info = node.querySelector('.info') || node;
    const nameNode = info.querySelector('.name') || info.querySelector('a[href*="/film/"]') || info.querySelector('a');
    const spans = Array.from(info.querySelectorAll('span')).map((span) => cleanText(span.textContent)).filter(Boolean);
    const title = cleanText(nameNode && nameNode.textContent);
    const alt = spans.find((text) => text !== title) || '';
    const dateAdded = cleanText((node.querySelector('.date') || {}).textContent) || spans[spans.length - 1] || '';

    return {
      id,
      name: title || alt || ('Kinopoisk ' + id),
      alt_name: alt,
      date_added: dateAdded,
      source_url: sourceUrl
    };
  }

  function discoverLinkedPageUrls(doc) {
    const urls = new Set();
    doc.querySelectorAll('a[href]').forEach((anchor) => {
      const href = anchor.getAttribute('href') || '';
      if (!/\/mykp\/folders\//.test(href)) return;
      const url = new URL(href, location.href);
      if (url.searchParams.has('page') || /\bpage\b/i.test(anchor.textContent || '')) urls.add(url.href);
    });
    return Array.from(urls);
  }

  function pageUrl(base, page) {
    const url = new URL(base);
    url.searchParams.set('page', String(page));
    return url.href;
  }

  function pushUnique(target, seen, movies) {
    movies.forEach((movie) => {
      if (!movie.id || seen.has(movie.id)) return;
      seen.add(movie.id);
      target.push(movie);
    });
  }

  function samePage(a, b) {
    const first = new URL(a, location.href);
    const second = new URL(b, location.href);
    return first.href === second.href;
  }

  function normalizeCode(code) {
    return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '');
  }

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function updateButton(text) {
    const button = document.getElementById('lampa-kp-import-button');
    if (button) button.textContent = text;
  }
})();
