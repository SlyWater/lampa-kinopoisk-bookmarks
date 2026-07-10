# Lampa Kinopoisk Bookmarks

Плагин для Lampa, который добавляет статусы закладок в карточку фильма и показывает рейтинги Кинопоиска/IMDb на постерах.

## Возможности

- Кнопка `Закладка` в полной карточке фильма.
- Статусы `Буду смотреть`, `Смотрю`, `Отложено`, `Убрать`.
- Двусторонняя синхронизация `Буду смотреть` с папкой Кинопоиска `Буду смотреть`.
- `Смотрю` и `Отложено` в v1 хранятся локально в `Lampa.Storage`.
- Бейджи `KP` и `IMDb` на постерах и в полной карточке, если рейтинг найден через Alloha.

## Структура

- `plugin/kinopoisk-bookmarks.js` - standalone JS-плагин для Lampa.
- `worker/src/index.js` - Cloudflare Worker-прокси для OAuth, Kinopoisk GraphQL и Alloha resolve.
- `shared/core.mjs` - чистые функции, покрытые тестами.
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
