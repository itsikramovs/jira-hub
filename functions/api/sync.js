// =====================================================================
// GET/POST /api/sync  — тянет данные из всех сайтов Jira в Supabase.
// Защита: заголовок  Authorization: Bearer <SYNC_SECRET>
//         или ?secret=<SYNC_SECRET>
// Вызывается по расписанию (cron-job.org / GitHub Actions / вручную).
// =====================================================================
import { json, parseSites, jiraFetch, sb } from "../_lib.js";

const MAX_ISSUES_PER_PROJECT = 300;   // ограничение, чтобы синк был лёгким
const PAGE = 100;

export async function onRequest(context) {
  const { request, env } = context;

  // --- авторизация ---
  const url = new URL(request.url);
  const provided =
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("secret") ||
    "";
  if (!env.SYNC_SECRET || provided !== env.SYNC_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const store = sb(env);
  const allSites = parseSites(env);
  if (!allSites.length) return json({ ok: false, error: "JIRA_SITES не задан" }, 400);

  // Опционально: синхронизировать только один сайт (?site=xxx).
  // Это обходит лимит Cloudflare на число подзапросов в одной инвокации:
  // клиент вызывает /api/sync?site=X по очереди для каждого сайта.
  const only = url.searchParams.get("site");
  const sites = only ? allSites.filter((s) => s.id === only) : allSites;
  if (only && !sites.length) return json({ ok: false, error: `site '${only}' не найден в JIRA_SITES` }, 400);

  // Каждый сайт синхронизируем независимо: ошибка одного не останавливает остальные.
  const summary = [];
  const errors = [];
  for (const site of sites) {
    try {
      const r = await syncSite(env, store, site);
      summary.push(r);
    } catch (err) {
      errors.push({ site: site.id, error: String(err).slice(0, 300) });
    }
  }
  await store
    .insert("sync_log", [{ finished_at: new Date().toISOString(), ok: errors.length === 0, detail: { summary, errors } }])
    .catch(() => {});
  return json({ ok: true, synced: summary, errors });
}

async function syncSite(env, store, site) {
  await store.upsert("sites", [{ id: site.id, name: site.id, base_url: site.base_url, updated_at: new Date().toISOString() }], "id");

  // ---- проекты ----
  const projects = [];
  let startAt = 0;
  while (true) {
    const data = await jiraFetch(env, site.host,
      `/rest/api/3/project/search?startAt=${startAt}&maxResults=${PAGE}&expand=lead,description`);
    for (const p of data.values || []) projects.push(p);
    if (data.isLast || !data.values?.length) break;
    startAt += PAGE;
  }

  const projectRows = [];
  const memberRows = new Map();     // account_id -> row
  const projectMemberRows = [];
  const issueRows = [];
  let issueCount = 0;

  for (const p of projects) {
    const projId = `${site.id}:${p.id}`;
    const lead = p.lead;
    if (lead?.accountId) memberRows.set(lead.accountId, memberFromUser(lead));

    projectRows.push({
      id: projId,
      site_id: site.id,
      project_id: String(p.id),
      project_key: p.key,
      name: p.name,
      lead_account_id: lead?.accountId || null,
      category: p.projectCategory?.name || null,
      url: `${site.base_url}/browse/${p.key}`,
      updated_at: new Date().toISOString(),
    });

    // ---- участники проекта (assignable users) ----
    try {
      const users = await jiraFetch(env, site.host,
        `/rest/api/3/user/assignable/search?project=${encodeURIComponent(p.key)}&maxResults=${PAGE}`);
      for (const u of users || []) {
        if (u.accountType && u.accountType !== "atlassian") continue; // отсекаем ботов/приложения
        if (!u.accountId) continue;
        memberRows.set(u.accountId, memberFromUser(u));
        projectMemberRows.push({ project_id: projId, account_id: u.accountId, role: "member" });
      }
    } catch (_) { /* у некоторых проектов может не быть прав — пропускаем */ }

    // ---- задачи (enhanced search /search/jql, пагинация по nextPageToken) ----
    let nextPageToken = null;
    while (issueCount < MAX_ISSUES_PER_PROJECT) {
      const params = new URLSearchParams({
        jql: `project = "${p.key}" ORDER BY updated DESC`,
        maxResults: String(PAGE),
        fields: "summary,status,assignee,reporter,priority,issuetype,updated",
      });
      if (nextPageToken) params.set("nextPageToken", nextPageToken);
      const data = await jiraFetch(env, site.host, `/rest/api/3/search/jql?${params.toString()}`);
      for (const it of data.issues || []) {
        const f = it.fields || {};
        if (f.assignee?.accountId) memberRows.set(f.assignee.accountId, memberFromUser(f.assignee));
        issueRows.push({
          id: `${site.id}:${it.id}`,
          site_id: site.id,
          project_id: projId,
          issue_key: it.key,
          summary: f.summary || "",
          status: f.status?.name || null,
          status_category: f.status?.statusCategory?.key || null,
          issue_type: f.issuetype?.name || null,
          priority: f.priority?.name || null,
          assignee_account_id: f.assignee?.accountId || null,
          assignee_name: f.assignee?.displayName || null,
          reporter_name: f.reporter?.displayName || null,
          url: `${site.base_url}/browse/${it.key}`,
          updated: f.updated || null,
          synced_at: new Date().toISOString(),
        });
        issueCount++;
      }
      if (data.isLast || !data.nextPageToken || !data.issues?.length) break;
      nextPageToken = data.nextPageToken;
    }
  }

  // ---- запись в Supabase ----
  // проекты и задачи этого сайта пересобираем начисто, чтобы удалённые исчезали
  await store.delete("issues", `?site_id=eq.${site.id}`);
  await store.delete("project_members", `?project_id=like.${site.id}:*`);
  await store.delete("projects", `?site_id=eq.${site.id}`);

  // дедуп связей проект<->участник (защита от ON CONFLICT второй раз)
  const seenPM = new Set();
  const pmDedup = projectMemberRows.filter((r) => {
    const k = `${r.project_id}|${r.account_id}`;
    if (seenPM.has(k)) return false;
    seenPM.add(k);
    return true;
  });

  await store.upsert("members", [...memberRows.values()], "account_id");
  await chunkedUpsert(store, "projects", projectRows, "id");
  await chunkedUpsert(store, "project_members", pmDedup, "project_id,account_id");
  await chunkedUpsert(store, "issues", issueRows, "id");

  return { site: site.id, projects: projectRows.length, members: memberRows.size, issues: issueRows.length };
}

function memberFromUser(u) {
  return {
    account_id: u.accountId,
    display_name: u.displayName || null,
    email: u.emailAddress || null,
    avatar_url: u.avatarUrls?.["48x48"] || null,
    active: u.active !== false,
    updated_at: new Date().toISOString(),
  };
}

async function chunkedUpsert(store, table, rows, onConflict, size = 200) {
  for (let i = 0; i < rows.length; i += size) {
    await store.upsert(table, rows.slice(i, i + size), onConflict);
  }
}
