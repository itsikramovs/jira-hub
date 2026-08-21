# Jira Hub — единый дашборд + Telegram-бот

Агрегирует все ваши сайты Jira (`*.atlassian.net`) в один дашборд и позволяет ставить задачи в Jira прямо из Telegram (текст оформляет ИИ Gemini).

- **Дашборд:** проекты, задачи по проектам, участники, «кто чем занят». Доступ по ссылке, без логина.
- **Telegram-бот:** `/new` → выбор проекта и исполнителя кнопками → текст задачи → Gemini оформляет → задача появляется в Jira.
- **Стек:** Cloudflare Pages (статика + серверные функции) + Supabase (база данных). Все секреты (Jira, Gemini) живут только на сервере и в браузер не попадают.

---

## Как это работает (общая картина)

```
Браузер ──/api/data──▶ Cloudflare Function ──▶ Supabase (кэш данных)
                                                    ▲
Планировщик ──/api/sync──▶ Cloudflare Function ─────┤
                                                    └─▶ Jira (все сайты)

Telegram ──/api/telegram──▶ Cloudflare Function ──▶ Gemini ──▶ Jira (создать задачу)
                                     └──▶ Supabase (проекты, участники, состояние диалога)
```

Идея: браузер никогда не видит токен Jira. Он обращается только к `/api/data`, который отдаёт уже готовые данные из Supabase. А наполняет Supabase периодическая синхронизация `/api/sync`, которая ходит в Jira с сервера.

**Что понадобится завести (по ходу инструкции):** аккаунт Supabase, API-токен Jira, бот в Telegram, ключ Gemini, аккаунт Cloudflare и git-репозиторий (GitHub). Всё бесплатно на нужных нам объёмах.

---

## Структура проекта

```
jira-hub/
├─ public/index.html          дашборд (весь интерфейс, без сборки)
├─ functions/
│  ├─ _lib.js                  общие помощники (Jira, Supabase, ADF)
│  └─ api/
│     ├─ data.js              GET  /api/data      данные для дашборда
│     ├─ sync.js              GET  /api/sync      Jira → Supabase (по секрету)
│     ├─ telegram.js          POST /api/telegram  вебхук бота
│     └─ setup.js             GET  /api/setup     регистрация вебхука (по секрету)
├─ supabase/schema.sql        схема базы данных
├─ .github/workflows/sync.yml планировщик синхронизации
├─ .env.example               список всех переменных окружения
└─ package.json
```

---

# Пошаговое развёртывание

Идите строго сверху вниз. По ходу заполняйте табличку значений — они понадобятся на шаге 6.

| Переменная | Где взять | Значение (впишите) |
|---|---|---|
| `JIRA_EMAIL` | шаг 2 | |
| `JIRA_API_TOKEN` | шаг 2 | |
| `JIRA_SITES` | шаг 2 | |
| `SUPABASE_URL` | шаг 1 | |
| `SUPABASE_SERVICE_ROLE` | шаг 1 | |
| `SYNC_SECRET` | шаг 3 (придумать) | |
| `TELEGRAM_BOT_TOKEN` | шаг 4 | |
| `TELEGRAM_WEBHOOK_SECRET` | шаг 4 (придумать) | |
| `GEMINI_API_KEY` | шаг 5 | |
| `GEMINI_MODEL` | по желанию | `gemini-2.0-flash` |

---

## Шаг 1. Supabase (база данных)

1. Зайдите на [supabase.com](https://supabase.com) → **Start your project** → войдите (можно через GitHub).
2. Нажмите **New project**. Задайте:
   - **Name:** `jira-hub` (любое)
   - **Database Password:** сгенерируйте и сохраните (пригодится только для прямого доступа к БД, в нашем случае не обязателен).
   - **Region:** ближайший к вам.
   - Нажмите **Create new project** и подождите ~2 минуты, пока проект поднимется.
3. Создайте таблицы. Слева в меню откройте **SQL Editor** → **New query**.
   - Откройте файл `supabase/schema.sql` из этого проекта, скопируйте **всё** его содержимое.
   - Вставьте в редактор и нажмите **Run** (или Ctrl/Cmd+Enter).
   - Внизу должно появиться «Success. No rows returned». Значит таблицы созданы.
4. Возьмите ключи. Слева **Project Settings** (шестерёнка) → **API**:
   - **Project URL** (вида `https://abcdxyz.supabase.co`) → это `SUPABASE_URL`.
   - Блок **Project API keys** → ключ **`service_role`** (нажмите «Reveal», он длинный, начинается с `eyJ...`) → это `SUPABASE_SERVICE_ROLE`.

> ⚠️ `service_role` — это секрет с полным доступом к базе. Его вставляют **только** в переменные Cloudflare (шаг 6). Никогда не кладите его в код или во фронтенд.

Впишите `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE` в табличку.

---

## Шаг 2. Jira (доступ ко всем сайтам)

1. Откройте [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) под тем аккаунтом-админом, у которого есть доступ ко всем нужным сайтам.
2. **Create API token** → задайте имя (`jira-hub`) → **Create** → **Copy**. Это `JIRA_API_TOKEN` (показывается один раз — сразу сохраните).
3. `JIRA_EMAIL` — почта этого аккаунта Atlassian.
4. `JIRA_SITES` — перечислите поддомены ваших сайтов через запятую. Если сайты `acme.atlassian.net` и `team2.atlassian.net`, то значение: `acme, team2` (можно и полными хостами: `acme.atlassian.net, team2.atlassian.net`).
   - Важно: аккаунт из шага 2 должен реально состоять в каждом из этих сайтов, иначе синхронизация по нему ничего не увидит.

Впишите `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_SITES` в табличку.

**Проверка токена (по желанию).** В терминале (подставьте свои значения):
```bash
curl -u "you@example.com:ВАШ_ТОКЕН" "https://acme.atlassian.net/rest/api/3/myself"
```
Если вернулся JSON с вашим `accountId` — токен и доступ рабочие.

---

## Шаг 3. Придумайте SYNC_SECRET

Это пароль, которым защищены служебные адреса `/api/sync` и `/api/setup`, чтобы их не мог дёрнуть посторонний.

- Придумайте длинную случайную строку (20+ символов). Например, сгенерируйте:
  ```bash
  openssl rand -hex 24
  ```
- Впишите её как `SYNC_SECRET` в табличку.

---

## Шаг 4. Telegram-бот

1. В Telegram откройте [@BotFather](https://t.me/BotFather) → отправьте `/newbot`.
2. Задайте имя бота и username (должен заканчиваться на `bot`).
3. BotFather пришлёт **токен** вида `123456789:AAE...` → это `TELEGRAM_BOT_TOKEN`.
4. Придумайте `TELEGRAM_WEBHOOK_SECRET` — ещё одну случайную строку (как в шаге 3). Она нужна, чтобы принимать вебхуки только от Telegram.

Впишите `TELEGRAM_BOT_TOKEN` и `TELEGRAM_WEBHOOK_SECRET` в табличку.

---

## Шаг 5. Gemini (ИИ для оформления задач)

1. Откройте [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → войдите Google-аккаунтом.
2. **Create API key** → скопируйте ключ (`AIza...`) → это `GEMINI_API_KEY`.

Впишите `GEMINI_API_KEY` в табличку. Модель по умолчанию `gemini-2.0-flash` — менять не нужно.

---

## Шаг 6. Cloudflare Pages (хостинг + серверные функции)

### 6.1. Залейте проект в GitHub
1. Создайте репозиторий на [github.com/new](https://github.com/new) (можно приватный), например `jira-hub`.
2. Загрузите туда содержимое папки `jira-hub`. Либо через веб-интерфейс GitHub («uploading an existing file»), либо командами:
   ```bash
   cd jira-hub
   git init
   git add .
   git commit -m "Jira Hub"
   git branch -M main
   git remote add origin https://github.com/ВАШ_ЛОГИН/jira-hub.git
   git push -u origin main
   ```

### 6.2. Подключите к Cloudflare
1. Зайдите в [dash.cloudflare.com](https://dash.cloudflare.com) → слева **Workers & Pages** → **Create** → вкладка **Pages** → **Connect to Git**.
2. Авторизуйте GitHub, выберите репозиторий `jira-hub` → **Begin setup**.
3. Настройки сборки (проект — **Pages**; статику и папку `functions/` платформа разворачивает сама):
   - **Project name:** `jira-hub`.
   - **Production branch:** `main`.
   - **Framework preset:** **None**.
   - **Build command:** оставьте **пустым**.
   - **Deploy command:** оставьте **ПУСТЫМ** (это критично, см. ниже).
   - **Build output directory:** `public`.
   - Если вы залили в репозиторий не содержимое папки, а саму папку `jira-hub` целиком — укажите **Root directory** = `jira-hub`.
4. Пока **не** нажимайте финальный деплой, если есть возможность сразу добавить переменные. Если Cloudflare требует задеплоить сначала — задеплойте, переменные добавим следующим пунктом и передеплоим.

> ⚠️ **Самая частая причина падений сборки — заданная «Deploy command».** У обычного Pages-проекта её быть НЕ должно: платформа сама берёт папку `public` и функции из `functions/` и разворачивает их. Если в поле **Deploy command** стоит `npx wrangler deploy` или `npx wrangler pages deploy` — **очистите это поле** и сохраните. Также, если вы вручную добавляли переменную `CLOUDFLARE_API_TOKEN` — удалите её (для встроенного деплоя Pages она не нужна и мешает).
> В репозитории должен лежать `wrangler.toml` со строкой `pages_build_output_dir = "public"`.

### 6.3. Добавьте переменные окружения
1. Откройте проект → **Settings** → **Environment variables** (в некоторых версиях — **Variables and Secrets**).
2. Добавьте **все 10 переменных** из вашей таблички (кнопка **Add**). Это runtime-переменные Worker — именно их читает код (`env.X`). Секретные (`JIRA_API_TOKEN`, `SUPABASE_SERVICE_ROLE`, `SYNC_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `GEMINI_API_KEY`) добавляйте как тип **Secret**.
3. Полный список имён — в файле `.env.example`.

> Если раздел называется «Variables and Secrets» и разделён на **Build**-переменные и **Runtime**-переменные — добавляйте в **Runtime** (их видит работающий Worker).

### 6.4. Передеплой
- Вкладка **Deployments** → у последнего деплоя меню **⋯** → **Retry deployment** (чтобы подхватились переменные). Дождитесь статуса **Success**.
- Запомните адрес проекта: `https://ВАШ-ПРОЕКТ.pages.dev`.

---

## Шаг 7. Первая синхронизация и включение бота

Откройте в браузере два адреса (подставьте свой домен и `SYNC_SECRET`):

1. Наполнить дашборд данными из Jira:
   ```
   https://ВАШ-ПРОЕКТ.pages.dev/api/sync?secret=ВАШ_SYNC_SECRET
   ```
   Должен вернуться JSON вида `{"ok":true,"sites":[{"site":"acme","projects":12,"issues":340,...}]}`. Первый прогон может занять минуту.

2. Включить вебхук Telegram-бота:
   ```
   https://ВАШ-ПРОЕКТ.pages.dev/api/setup?secret=ВАШ_SYNC_SECRET
   ```
   Должен вернуться JSON с `"setWebhook":{"ok":true,...}`.

Теперь:
- **Дашборд** — откройте корневой адрес `https://ВАШ-ПРОЕКТ.pages.dev`. Вкладки: Проекты, Задачи, Кто чем занят, Участники.
- **Бот** — напишите ему в Telegram `/new`, выберите проект и исполнителя кнопками, пришлите текст задачи. Через пару секунд придёт ссылка на созданную задачу в Jira.

---

## Шаг 8. Автоматическая синхронизация (выберите один способ)

Данные в дашборде обновляются при каждом вызове `/api/sync`. Настройте регулярный запуск:

**Вариант А — GitHub Actions (уже в проекте).**
1. В репозитории: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Добавьте два секрета:
   - `SYNC_URL` = `https://ВАШ-ПРОЕКТ.pages.dev/api/sync`
   - `SYNC_SECRET` = ваш `SYNC_SECRET`
3. Файл `.github/workflows/sync.yml` уже настроен пинговать этот адрес каждые 30 минут. Проверить вручную: вкладка **Actions** → workflow **Jira sync** → **Run workflow**.

**Вариант Б — cron-job.org (без GitHub).**
1. Зарегистрируйтесь на [cron-job.org](https://cron-job.org).
2. Создайте задание: URL `https://ВАШ-ПРОЕКТ.pages.dev/api/sync?secret=ВАШ_SYNC_SECRET`, интервал, например, каждые 30 минут.

**Вариант В — вручную.** Кнопка **⟳ Синхронизировать** в дашборде (спросит `SYNC_SECRET`).

---

## Проверка, что всё работает

1. `/api/sync?secret=...` вернул `ok:true` и ненулевые `projects`/`issues`.
2. На дашборде во вкладке «Проекты» видны проекты со всех сайтов, счётчики задач не пустые.
3. Вкладка «Кто чем занят» показывает людей с активными задачами.
4. Бот на `/new` показывает список проектов кнопками и в конце присылает ссылку на созданную задачу.

---

## Возможные проблемы и решения

- **Ошибки деплоя с `wrangler` (любые из перечисленных ниже).** Почти всегда причина одна: в проекте задана **своя Deploy command**. Решение — **очистить поле Deploy command** (Settings → Build) и удалить вручную добавленную переменную `CLOUDFLARE_API_TOKEN`, затем Retry deployment. Типичные симптомы этой проблемы:
  - `It looks like you've run a Workers-specific command in a Pages project` — стоит `npx wrangler deploy`, а проект — Pages.
  - `Authentication error [code: 10000]` — стоит `npx wrangler pages deploy` с неподходящим токеном в `CLOUDFLARE_API_TOKEN`.
  - `Missing entry-point to Worker script` — Worker-команда без точки входа.
  - Во всех случаях правильно — **пустая Deploy command** (Pages деплоит сам) + `wrangler.toml` с `pages_build_output_dir = "public"`. Предупреждение «Wrangler is out-of-date» безвредно.
- **Гарантированный запасной вариант — деплой со своего компьютера.** Если UI не даёт очистить Deploy command, разверните вручную: `npm i -g wrangler`, `wrangler login` (откроется браузер, войдите), затем `wrangler pages deploy public --project-name=jira-hub`. Переменные окружения после этого задайте в дашборде проекта, повторный деплой — этой же командой.
- **`/api/sync` → `unauthorized`.** Неверный `SYNC_SECRET` в адресе или в переменных Cloudflare. Сверьте.
- **`/api/sync` → ошибка `Jira ... 401/403`.** Неверные `JIRA_EMAIL`/`JIRA_API_TOKEN`, либо аккаунт не состоит в этом сайте. Проверьте токен командой `curl` из шага 2.
- **Дашборд пустой, «Ошибка …».** Проверьте `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE`, и что `schema.sql` выполнен. Затем прогоните `/api/sync`.
- **Бот не отвечает.** Ещё раз откройте `/api/setup?secret=...` (после смены домена вебхук надо переустановить). Проверьте `TELEGRAM_BOT_TOKEN`. Диагностика: `https://api.telegram.org/bot<ТОКЕН>/getWebhookInfo`.
- **Бот пишет «Не удалось создать задачу … нет типа Task».** В этом проекте Jira нет типа задачи «Task». Откройте `functions/api/telegram.js`, найдите `issuetype: { name: "Task" }` и замените на имя типа из вашего проекта (например, `"Задача"` или `"Story"`).
- **В боте не весь список проектов/исполнителей.** Списки ограничены (50 проектов, 40 исполнителей на экран) из-за лимитов кнопок Telegram. При необходимости поднимите лимиты в `startNew`/`showAssignees` в `telegram.js`.

---

## Локальный запуск (для разработки)

```bash
cd jira-hub
npm install
# создайте файл .dev.vars рядом с package.json,
# формат тот же, что в .env.example (KEY=value построчно)
npx wrangler pages dev public
```

Откроется локальный адрес; статика и `/api/*` работают с вашими переменными из `.dev.vars`.

---

## Замечания и ограничения

- Синхронизация тянет до 300 последних задач на проект (константа `MAX_ISSUES_PER_PROJECT` в `sync.js`) — чтобы прогон был быстрым и лёгким. Поднимите при необходимости.
- «Участники проекта» — это пользователи, которым можно назначать задачи (assignable users) в данном проекте.
- Дашборд открыт по ссылке без логина (по вашему выбору). Чтобы закрыть доступ — включите **Cloudflare Access** поверх Pages; менять ключи при этом не нужно.
- Используется современный эндпоинт поиска Jira `/rest/api/3/search/jql` и модель `gemini-2.0-flash` (актуальны на 2025). При деплое стоит сверить детали с их живой документацией, если что-то поменялось.
