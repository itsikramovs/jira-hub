// =====================================================================
// Единая точка входа Cloudflare Worker.
// Роутит /api/* на обработчики, всё остальное отдаёт из статики (./public).
// Обработчики переиспользуются из functions/api/*.js (сигнатура onRequest).
// =====================================================================
import { onRequest as data } from "./functions/api/data.js";
import { onRequest as sync } from "./functions/api/sync.js";
import { onRequest as telegram } from "./functions/api/telegram.js";
import { onRequest as setup } from "./functions/api/setup.js";

const routes = {
  "/api/data": data,
  "/api/sync": sync,
  "/api/telegram": telegram,
  "/api/setup": setup,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const handler = routes[url.pathname];
    if (handler) {
      // тот же объект-контекст, что ждут функции (context.request/context.env)
      return handler({ request, env, ctx });
    }
    // не /api/* → отдать статический файл (index.html и т.п.)
    return env.ASSETS.fetch(request);
  },
};
