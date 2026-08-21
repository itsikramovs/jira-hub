-- =====================================================================
-- Jira Hub — схема Supabase (Postgres)
-- Выполните этот SQL в Supabase → SQL Editor.
-- =====================================================================

-- Сайты Atlassian, которые агрегируем
create table if not exists sites (
  id          text primary key,          -- ключ сайта, напр. "acme" (из acme.atlassian.net)
  name        text,
  base_url    text not null,             -- https://acme.atlassian.net
  updated_at  timestamptz default now()
);

-- Участники (account_id глобален для аккаунта Atlassian => дедуп между сайтами)
create table if not exists members (
  account_id   text primary key,
  display_name text,
  email        text,
  avatar_url   text,
  active       boolean default true,
  updated_at   timestamptz default now()
);

-- Проекты
create table if not exists projects (
  id              text primary key,      -- "<site_id>:<project_id>"
  site_id         text references sites(id) on delete cascade,
  project_id      text,
  project_key     text,
  name            text,
  lead_account_id text,
  category        text,
  url             text,
  updated_at      timestamptz default now()
);

-- Связь проект <-> участник (кто в проекте)
create table if not exists project_members (
  project_id  text references projects(id) on delete cascade,
  account_id  text,
  role        text,
  primary key (project_id, account_id)
);

-- Задачи
create table if not exists issues (
  id                  text primary key,  -- "<site_id>:<issue_id>"
  site_id             text references sites(id) on delete cascade,
  project_id          text references projects(id) on delete cascade,
  issue_key           text,
  summary             text,
  status              text,
  status_category     text,              -- new / indeterminate / done
  issue_type          text,
  priority            text,
  assignee_account_id text,
  assignee_name       text,
  reporter_name       text,
  url                 text,
  updated             timestamptz,
  synced_at           timestamptz default now()
);

-- Состояние диалога Telegram-бота (функции без состояния => храним здесь)
create table if not exists bot_state (
  chat_id     text primary key,
  state       jsonb default '{}'::jsonb,
  updated_at  timestamptz default now()
);

-- Служебная таблица: когда последний раз синхронизировали
create table if not exists sync_log (
  id          bigserial primary key,
  started_at  timestamptz default now(),
  finished_at timestamptz,
  ok          boolean,
  detail      jsonb
);

create index if not exists idx_issues_project on issues(project_id);
create index if not exists idx_issues_assignee on issues(assignee_account_id);
create index if not exists idx_issues_status_cat on issues(status_category);
create index if not exists idx_projects_site on projects(site_id);

-- =====================================================================
-- RLS: доступ к данным только через service role (Cloudflare Functions).
-- Браузер НЕ обращается к Supabase напрямую и не хранит ключей.
-- Включаем RLS без публичных политик => anon/public не читают напрямую.
-- service_role обходит RLS.
-- =====================================================================
alter table sites            enable row level security;
alter table members          enable row level security;
alter table projects         enable row level security;
alter table project_members  enable row level security;
alter table issues           enable row level security;
alter table bot_state        enable row level security;
alter table sync_log         enable row level security;
