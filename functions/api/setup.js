// =====================================================================
// GET /api/setup?secret=SYNC_SECRET
// Регистрирует вебхук Telegram на текущий домен и задаёт команды бота.
// Вызвать один раз после деплоя (и после смены домена).
// =====================================================================
import { json } from "../_lib.js";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!env.SYNC_SECRET || url.searchParams.get("secret") !== env.SYNC_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const webhookUrl = `${url.origin}/api/telegram`;
  const api = (m, p) =>
    fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${m}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    }).then((r) => r.json());

  const setHook = await api("setWebhook", {
    url: webhookUrl,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });

  const setCmds = await api("setMyCommands", {
    commands: [
      { command: "new", description: "Создать задачу в Jira" },
      { command: "cancel", description: "Отменить текущий ввод" },
      { command: "help", description: "Помощь" },
    ],
  });

  return json({ ok: true, webhook: webhookUrl, setWebhook: setHook, setMyCommands: setCmds });
}
