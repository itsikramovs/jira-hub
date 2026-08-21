// =====================================================================
// Общие помощники для Cloudflare Pages Functions
// (файлы с префиксом "_" не становятся маршрутами — это библиотека)
// =====================================================================

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}

// ---- Jira ----------------------------------------------------------

// Список сайтов из переменной окружения JIRA_SITES.
// Принимает "acme, foo" или "acme.atlassian.net, https://foo.atlassian.net".
export function parseSites(env) {
  const raw = (env.JIRA_SITES || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      let host = s.replace(/^https?:\/\//, "").replace(/\/$/, "");
      if (!host.includes(".")) host = `${host}.atlassian.net`;
      const id = host.split(".")[0];
      return { id, host, base_url: `https://${host}` };
    });
}

export function jiraAuthHeader(env) {
  const token = btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
  return `Basic ${token}`;
}

export async function jiraFetch(env, host, path, init = {}) {
  const res = await fetch(`https://${host}${path}`, {
    ...init,
    headers: {
      authorization: jiraAuthHeader(env),
      accept: "application/json",
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira ${host} ${path} -> ${res.status}: ${body.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Текст -> Atlassian Document Format (нужен для create issue в API v3)
export function toADF(text) {
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .map((block) => ({
      type: "paragraph",
      content: block
        ? [{ type: "text", text: block }]
        : [],
    }));
  return { type: "doc", version: 1, content: paragraphs.length ? paragraphs : [{ type: "paragraph", content: [] }] };
}

// ---- Supabase (REST, через service role) ---------------------------

export function sb(env) {
  const base = env.SUPABASE_URL.replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE;
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  return {
    async upsert(table, rows, onConflict) {
      if (!rows || !rows.length) return;
      const q = onConflict ? `?on_conflict=${onConflict}` : "";
      const res = await fetch(`${base}/rest/v1/${table}${q}`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows),
      });
      if (!res.ok) throw new Error(`Supabase upsert ${table}: ${res.status} ${await res.text()}`);
    },
    async select(table, query = "") {
      const res = await fetch(`${base}/rest/v1/${table}${query}`, { headers });
      if (!res.ok) throw new Error(`Supabase select ${table}: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async delete(table, query) {
      const res = await fetch(`${base}/rest/v1/${table}${query}`, {
        method: "DELETE",
        headers: { ...headers, Prefer: "return=minimal" },
      });
      if (!res.ok) throw new Error(`Supabase delete ${table}: ${res.status} ${await res.text()}`);
    },
    async insert(table, rows) {
      const res = await fetch(`${base}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify(rows),
      });
      if (!res.ok) throw new Error(`Supabase insert ${table}: ${res.status} ${await res.text()}`);
    },
  };
}
