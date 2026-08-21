// =====================================================================
// POST /api/telegram — вебхук Telegram-бота.
// Поток: /new -> выбор проекта (кнопки) -> выбор исполнителя (кнопки)
//        -> текст задачи -> обработка Gemini -> создание задачи в Jira.
// Состояние диалога хранится в Supabase (bot_state), т.к. функции без состояния.
// Защита: заголовок X-Telegram-Bot-Api-Secret-Token == TELEGRAM_WEBHOOK_SECRET
// =====================================================================
import { json, sb, jiraFetch, toADF } from "../_lib.js";

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return json({ ok: true, info: "telegram webhook" });

  // проверка секрета вебхука
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (env.TELEGRAM_WEBHOOK_SECRET && secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false }, 401);
  }

  let update;
  try { update = await request.json(); } catch { return json({ ok: true }); }

  try {
    if (update.callback_query) await onCallback(env, update.callback_query);
    else if (update.message) await onMessage(env, update.message);
  } catch (err) {
    // логируем в ответ бота, но всегда 200 для Telegram
    console.log("telegram error:", String(err));
  }
  return json({ ok: true });
}

// ---------- обработчики -------------------------------------------------

async function onMessage(env, msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();

  if (text === "/start" || text === "/help") {
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "👋 Я ставлю задачи в Jira.\n\n" +
        "Команды:\n" +
        "/new — создать задачу (выбор проекта и исполнителя кнопками)\n" +
        "/cancel — отменить\n\n" +
        "После выбора просто пришли текст задачи — я оформлю его через ИИ и создам issue.",
    });
  }

  if (text === "/cancel") {
    await setState(env, chatId, {});
    return tg(env, "sendMessage", { chat_id: chatId, text: "Отменено." });
  }

  if (text === "/new") {
    return startNew(env, chatId);
  }

  // ждём текст задачи?
  const st = await getState(env, chatId);
  if (st.step === "await_text" && st.project_key) {
    return createFromText(env, chatId, st, text);
  }

  return tg(env, "sendMessage", { chat_id: chatId, text: "Напишите /new чтобы создать задачу." });
}

async function onCallback(env, cq) {
  const chatId = String(cq.message.chat.id);
  const data = cq.data || "";
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });

  if (data.startsWith("proj:")) {
    const projectId = data.slice(5);
    const store = sb(env);
    const [p] = await store.select("projects", `?id=eq.${encodeURIComponent(projectId)}&select=*`);
    if (!p) return tg(env, "sendMessage", { chat_id: chatId, text: "Проект не найден, попробуйте /new снова." });
    const site = await store.select("sites", `?id=eq.${encodeURIComponent(p.site_id)}&select=base_url`);
    await setState(env, chatId, {
      step: "await_assignee",
      project_id: p.id, project_key: p.project_key, project_name: p.name,
      site_id: p.site_id, site_host: (site[0]?.base_url || "").replace(/^https?:\/\//, ""),
    });
    return showAssignees(env, chatId, p);
  }

  if (data.startsWith("asg:")) {
    const acc = data.slice(4); // accountId | "none"
    const st = await getState(env, chatId);
    if (!st.project_key) return tg(env, "sendMessage", { chat_id: chatId, text: "Сессия сброшена, наберите /new." });
    let name = "без исполнителя";
    if (acc !== "none") {
      const [m] = await sb(env).select("members", `?account_id=eq.${encodeURIComponent(acc)}&select=display_name`);
      name = m?.display_name || acc;
    }
    await setState(env, chatId, { ...st, step: "await_text", assignee_id: acc === "none" ? null : acc, assignee_name: name });
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: `Проект: *${escMd(st.project_name)}*\nИсполнитель: *${escMd(name)}*\n\n✍️ Пришлите текст задачи одним сообщением.`,
      parse_mode: "Markdown",
    });
  }
}

// ---------- шаги --------------------------------------------------------

async function startNew(env, chatId) {
  const store = sb(env);
  const projects = await store.select("projects", "?select=id,project_key,name,site_id&order=name&limit=60");
  if (!projects.length) {
    return tg(env, "sendMessage", { chat_id: chatId, text: "Нет проектов. Сначала запустите синхронизацию дашборда." });
  }
  await setState(env, chatId, { step: "await_project" });
  const buttons = projects.slice(0, 50).map((p) => [{ text: `${p.project_key} — ${p.name}`.slice(0, 60), callback_data: `proj:${p.id}` }]);
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text: "📁 Выберите проект:",
    reply_markup: { inline_keyboard: buttons },
  });
}

async function showAssignees(env, chatId, p) {
  const store = sb(env);
  const pm = await store.select("project_members", `?project_id=eq.${encodeURIComponent(p.id)}&select=account_id&limit=40`);
  const ids = pm.map((x) => x.account_id);
  let members = [];
  if (ids.length) {
    const inList = ids.map((i) => `"${i}"`).join(",");
    members = await store.select("members", `?account_id=in.(${encodeURIComponent(inList)})&select=account_id,display_name&order=display_name`);
  }
  const rows = [[{ text: "🚫 Не назначать", callback_data: "asg:none" }]];
  members.slice(0, 40).forEach((m) => rows.push([{ text: (m.display_name || m.account_id).slice(0, 60), callback_data: `asg:${m.account_id}` }]));
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text: `Проект *${escMd(p.name)}*.\n👤 Выберите исполнителя:`,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

async function createFromText(env, chatId, st, text) {
  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });

  // 1) обработка Gemini -> {summary, description}
  let parsed;
  try { parsed = await geminiStructure(env, text); }
  catch { parsed = { summary: text.slice(0, 120), description: text }; }

  // 2) создание задачи в Jira
  const fields = {
    project: { key: st.project_key },
    summary: parsed.summary || text.slice(0, 120),
    description: toADF(parsed.description || text),
    issuetype: { name: "Task" },
  };
  if (st.assignee_id) fields.assignee = { accountId: st.assignee_id };

  try {
    const created = await jiraFetch(env, st.site_host, "/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({ fields }),
    });
    const url = `https://${st.site_host}/browse/${created.key}`;
    await setState(env, chatId, {});
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: `✅ Задача создана: [${created.key}](${url})\n\n*${escMd(fields.summary)}*\nИсполнитель: ${escMd(st.assignee_name)}`,
      parse_mode: "Markdown",
      disable_web_page_preview: false,
    });
  } catch (err) {
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: `⚠️ Не удалось создать задачу.\n${String(err).slice(0, 400)}\n\nВозможно, в проекте нет типа "Task" или недостаточно прав. Наберите /new чтобы попробовать снова.`,
    });
  }
}

// ---------- Gemini ------------------------------------------------------

async function geminiStructure(env, text) {
  const model = env.GEMINI_MODEL || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const prompt =
    "Ты помощник, превращающий сообщение пользователя в задачу для Jira. " +
    "Верни СТРОГО JSON вида {\"summary\": string, \"description\": string}. " +
    "summary — короткий заголовок (до 120 символов) на языке сообщения, в повелительном наклонении. " +
    "description — развёрнутое описание: суть, при наличии — шаги/критерии приёмки. " +
    "Не добавляй ничего кроме JSON.\n\nСообщение:\n" + text;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const obj = JSON.parse(raw);
  return { summary: (obj.summary || "").slice(0, 250), description: obj.description || "" };
}

// ---------- утилиты -----------------------------------------------------

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
}

async function getState(env, chatId) {
  const rows = await sb(env).select("bot_state", `?chat_id=eq.${encodeURIComponent(chatId)}&select=state`);
  return rows[0]?.state || {};
}
async function setState(env, chatId, state) {
  await sb(env).upsert("bot_state", [{ chat_id: chatId, state, updated_at: new Date().toISOString() }], "chat_id");
}
function escMd(s) { return String(s ?? "").replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1"); }
