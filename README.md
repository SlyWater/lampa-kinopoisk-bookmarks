# Lampa Kinopoisk Bookmarks

Плагин для Lampa, который добавляет статусы закладок в карточку фильма и показывает рейтинги Кинопоиска/IMDb на постерах.

![Plugin icon](assets/icon.png)

## Возможности

- Кнопка `Закладка` в полной карточке фильма.
- Статусы `Буду смотреть`, `Смотрю`, `Отложено`, `Убрать`.
- Двусторонняя синхронизация `Буду смотреть` с папкой Кинопоиска `Буду смотреть`.
- Отдельный пункт меню Lampa `Буду смотреть` для списка Кинопоиска, без смешивания со стандартным `Позже`.
- Папка `Буду смотреть` на экране закладок Lampa рядом со штатными папками вроде `Позже`, если текущий DOM Lampa позволяет её вставить.
- `Смотрю` и `Отложено` в v1 хранятся локально в `Lampa.Storage`.
- Бейджи `KP` и `IMDb` на постерах и в полной карточке, если рейтинг найден через Alloha.

## Структура

- `plugin/kinopoisk-bookmarks.js` - standalone JS-плагин для Lampa.
- `worker/src/index.js` - Cloudflare Worker-прокси для OAuth, Kinopoisk GraphQL и Alloha resolve.
- `shared/core.mjs` - чистые функции, покрытые тестами.
- `assets/icon.png` - иконка для README/GitHub/Yandex OAuth приложения.
- `test/*.test.mjs` - unit/integration тесты с моками внешних API.

## Настройка Cloudflare Worker

1. Создайте OAuth-приложение Яндекса с device-code flow.
2. Разверните `worker/src/index.js` как Cloudflare Worker.
3. Задайте переменные окружения Worker:

```text
YANDEX_CLIENT_ID=...
YANDEX_CLIENT_SECRET=...
ALLOHA_TOKEN=...
```

`ALLOHA_TOKEN` опционален: если не задан, Worker использует публичный токен из известных Lampa-плагинов. Для стабильной работы лучше задать свой.

Опциональные переменные:

```text
KINOPOISK_GRAPHQL_URL=https://graphql.kinopoisk.ru/graphql/
DEBUG_RAW_KINOPOISK=1
DEBUG_RAW_ALLOHA=1
```

Можно начать с примера:

```powershell
Copy-Item worker/wrangler.toml.example worker/wrangler.toml
wrangler secret put YANDEX_CLIENT_ID
wrangler secret put YANDEX_CLIENT_SECRET
wrangler secret put ALLOHA_TOKEN
wrangler deploy --config worker/wrangler.toml
```

## Запуск на своём Ubuntu-сервере

Cloudflare Worker не обязателен. Тот же прокси можно запустить на своём сервере как маленький Node-сервис.

Минимальные требования:

- Node.js 18 или новее.
- Публичный HTTPS-домен или reverse proxy через nginx/Caddy.
- Переменные окружения `YANDEX_CLIENT_ID` и `YANDEX_CLIENT_SECRET`.

Локальный запуск:

```bash
cd /opt/lampa-kinopoisk-bookmarks
export YANDEX_CLIENT_ID="..."
export YANDEX_CLIENT_SECRET="..."
export PORT=8787
npm run serve:worker
```

Проверка:

```bash
curl http://127.0.0.1:8787/health
```

Пример systemd unit:

```ini
[Unit]
Description=Lampa Kinopoisk Bookmarks Proxy
After=network.target

[Service]
WorkingDirectory=/opt/lampa-kinopoisk-bookmarks
ExecStart=/usr/bin/node worker/node-server.js
Restart=always
Environment=HOST=127.0.0.1
Environment=PORT=8787
Environment=YANDEX_CLIENT_ID=...
Environment=YANDEX_CLIENT_SECRET=...

[Install]
WantedBy=multi-user.target
```

`ALLOHA_TOKEN` опционален и нужен только для более стабильного получения рейтингов/ID через Alloha. Авторизация Яндекса и синхронизация `Буду смотреть` работают без него.

Если прямой Kinopoisk GraphQL не возвращает пользовательский `plannedToWatch`, backend использует fallback через известный Apps Script endpoint из существующих Lampa-плагинов. Его можно отключить переменной `DISABLE_KINOPOISK_APPS_SCRIPT_FALLBACK=1`.

Дальше nginx/Caddy должен проксировать внешний HTTPS URL на `127.0.0.1:8787`. Именно внешний HTTPS URL нужно вставить в настройку `URL Worker` в Lampa.

Для `slywater.ru` выбран общий proxy URL:

```text
https://lampa-kp.slywater.ru
```

Он уже задан в плагине по умолчанию. Обычным пользователям не нужно заполнять `URL Worker`, если этот backend работает.

Готовые шаблоны для сервера:

- `deploy/lampa-kp.env.example`
- `deploy/lampa-kp.service.example`
- `deploy/nginx-lampa-kp.conf.example`

## Установка плагина в Lampa

1. Опубликуйте `plugin/kinopoisk-bookmarks.js` по HTTPS.
2. В Lampa откройте `Настройки -> Расширения -> Добавить плагин`.
3. Укажите URL опубликованного JS-файла.
4. В `Настройки -> Кинопоиск Закладки` укажите URL Worker, например:

```text
https://lampa-kp-bookmarks.example.workers.dev
```

5. Нажмите `Авторизоваться`, перейдите на `https://ya.ru/device` и введите код.
6. Нажмите `Синхронизировать Буду смотреть`.
7. Откройте пункт меню Lampa `Буду смотреть`.

При ручной синхронизации плагин запускает backend-job и показывает прогресс сборки карточек: сколько фильмов обработано, сколько карточек собрано, сколько сделано fallback-карточками и сколько не удалось сопоставить.

Если список пустой, откройте `Настройки -> Кинопоиск Закладки -> Диагностика`. Она покажет, сколько фильмов вернул Кинопоиск и сколько карточек удалось собрать для Lampa.

Backend собирает функциональные карточки по прямому `id_tmdb`, затем через IMDb `find`, затем через строгий поиск по названию с проверкой года. Если безопасно сопоставить TMDB не удалось, backend оставляет видимую fallback-карточку по данным Кинопоиска; такие карточки отмечены в диагностике как `fallbackCardsCount`.

## Проверки

```powershell
npm test
npm run check
```

## Ограничения v1

- Надёжно синхронизируется только `Буду смотреть`.
- `Смотрю` и `Отложено` локальные, потому что стабильный публично подтверждённый Kinopoisk API для этих статусов не найден.
- Kinopoisk GraphQL является неофициальным контрактом. Если схема изменится, нужно обновить query/mutation в Worker.
- DOM Lampa может меняться между версиями; плагин использует минимальные DOM-хуки и защищается от дублей кнопок/бейджей.
