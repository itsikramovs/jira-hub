// =====================================================================
// GET /api/data — агрегированные данные для дашборда.
// Читает из Supabase через service role (браузер ключей не видит).
// Возвращает: сайты, проекты (с числом задач/участников),
// задачи, участники, "кто чем занят".
// =====================================================================
import { json, sb, parseSites } from "../_lib.js";

export async function onRequest(context) {
  const { env } = context;
  const store = sb(env);
  const configuredSites = parseSites(env).map((s) => s.id);

  try {
    const [sites, projects, members, projectMembers, issues, syncLog] = await Promise.all([
      store.select("sites", "?select=*&order=name"),
      store.select("projects", "?select=*&order=name"),
      store.select("members", "?select=*"),
      store.select("project_members", "?select=*"),
      store.select("issues", "?select=*&order=updated.desc"),
      store.select("sync_log", "?select=finished_at,ok&order=id.desc&limit=1"),
    ]);

    const memberById = Object.fromEntries(members.map((m) => [m.account_id, m]));

    // --- проекты + метрики ---
    const membersByProject = {};
    for (const pm of projectMembers) {
      (membersByProject[pm.project_id] ||= new Set()).add(pm.account_id);
    }
    const issuesByProject = {};
    for (const it of issues) {
      (issuesByProject[it.project_id] ||= []).push(it);
    }

    const projectsOut = projects.map((p) => {
      const pIssues = issuesByProject[p.id] || [];
      const memberIds = [...(membersByProject[p.id] || [])];
      return {
        id: p.id,
        site_id: p.site_id,
        key: p.project_key,
        name: p.name,
        url: p.url,
        category: p.category,
        lead: memberById[p.lead_account_id]?.display_name || null,
        counts: {
          total: pIssues.length,
          todo: pIssues.filter((i) => i.status_category === "new").length,
          in_progress: pIssues.filter((i) => i.status_category === "indeterminate").length,
          done: pIssues.filter((i) => i.status_category === "done").length,
          members: memberIds.length,
        },
        member_ids: memberIds,
      };
    });

    // --- "кто чем занят": активные (не done) задачи по исполнителям ---
    const workloadMap = {};
    for (const it of issues) {
      if (!it.assignee_account_id) continue;
      if (it.status_category === "done") continue;
      const w = (workloadMap[it.assignee_account_id] ||= {
        account_id: it.assignee_account_id,
        name: it.assignee_name || memberById[it.assignee_account_id]?.display_name || "—",
        avatar_url: memberById[it.assignee_account_id]?.avatar_url || null,
        total: 0,
        in_progress: 0,
        issues: [],
      });
      w.total++;
      if (it.status_category === "indeterminate") w.in_progress++;
      w.issues.push({ key: it.issue_key, summary: it.summary, status: it.status, url: it.url, project_id: it.project_id });
    }
    const workload = Object.values(workloadMap).sort((a, b) => b.total - a.total);

    return json({
      ok: true,
      generated_at: new Date().toISOString(),
      last_sync: syncLog[0] || null,
      configured_sites: configuredSites,
      sites,
      projects: projectsOut,
      members,
      issues,
      workload,
      totals: {
        sites: sites.length,
        projects: projects.length,
        issues: issues.length,
        members: members.length,
        unassigned: issues.filter((i) => !i.assignee_account_id && i.status_category !== "done").length,
      },
    });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
}
