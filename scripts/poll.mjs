/**
 * Локальная проверка бота без деплоя: забирает сообщения из Telegram
 * и пересылает их в локальную функцию /api/bot (её запускает `npm run dev`).
 *
 * Внимание: снимает вебхук. После проверки нажмите в админке на сайте
 * «Подключить бота к сайту», чтобы бот снова работал через Netlify.
 */
import { createHash } from "node:crypto";

const token = process.env.TELEGRAM_BOT_TOKEN;
const target = process.env.LOCAL_BOT_URL || "http://localhost:8899/api/bot";
const secret = createHash("sha256").update("wh:" + token).digest("hex").slice(0, 48);
const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

await api("deleteWebhook");
console.log(`Пересылаю сообщения бота в ${target}. Ctrl+C — остановить.`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function forward(update) {
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify(update),
    });
    return res.ok;
  } catch (e) {
    console.error("Локальный сервер недоступен:", e.message);
    return false;
  }
}

let offset = 0;
for (;;) {
  const res = await api("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] }).catch(() => null);
  if (!res?.ok) {
    if (res?.error_code === 409) console.error("Бот подключён к сайту (вебхук), пересылка не нужна. Пробую снова через 10 секунд…");
    else console.error("Не удалось получить сообщения из Telegram:", res?.description ?? "нет связи");
    await sleep(res?.error_code === 409 ? 10000 : 3000);
    continue;
  }
  for (const update of res.result) {
    const text = update.message?.text ?? "(не текст)";
    console.log(`→ ${update.message?.from?.first_name ?? "?"}: ${text}`);
    // Отмечаем сообщение полученным только после успешной передачи боту
    if (!(await forward(update))) {
      await sleep(3000);
      break;
    }
    offset = update.update_id + 1;
  }
}
