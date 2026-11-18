import {
  json, isAdmin, tg, tgToken, tgSecret, loadSalon, seenUpdate, getChatHistory, saveChatHistory,
  newRequestId, saveRequest, requestMessage, withChatLock, splitMessage,
  getLastChatRequest, setLastChatRequest,
} from "../lib/store.mjs";
import { runTurn } from "../lib/ai.mjs";

// У функции Netlify есть 60 секунд на всё; оставляем запас, чтобы успеть ответить клиенту
const TIME_BUDGET_MS = 55000;

/**
 * POST /api/bot               — вебхук от Telegram
 * GET  /api/bot?action=setup  — подключить вебхук к этому сайту (только админ)
 * GET  /api/bot?action=test   — тестовое уведомление в чат администратора (только админ)
 * GET  /api/bot?action=info   — состояние бота (только админ)
 */
export default async (req, context) => {
  const deadline = Date.now() + TIME_BUDGET_MS;
  if (req.method === "GET") return adminAction(req);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (req.headers.get("x-telegram-bot-api-secret-token") !== tgSecret()) {
    return json({ error: "forbidden" }, 403);
  }

  const update = await req.json().catch(() => ({}));
  if (update.update_id != null && (await seenUpdate(update.update_id))) return json({ ok: true });

  // Сразу отвечаем Telegram, а сообщение обрабатываем в фоне (до 60 секунд)
  const chatId = update.message?.chat?.id;
  const work = (chatId ? withChatLock(chatId, () => handleUpdate(update, deadline)) : Promise.resolve())
    .catch((err) => console.error("Ошибка обработки", err));
  if (context?.waitUntil) context.waitUntil(work);
  else await work;
  return json({ ok: true });
};

async function adminAction(req) {
  if (!isAdmin(req)) return json({ error: "Нет доступа" }, 401);
  if (!tgToken()) return json({ error: "Не задана переменная TELEGRAM_BOT_TOKEN" }, 400);
  const action = new URL(req.url).searchParams.get("action");

  if (action === "setup") {
    const url = new URL("/api/bot", req.url).toString();
    const r = await tg("setWebhook", { url, secret_token: tgSecret(), allowed_updates: ["message"] });
    await tg("setMyCommands", {
      commands: [
        { command: "start", description: "Начать консультацию" },
        { command: "new", description: "Начать заново" },
        { command: "id", description: "ID чата (для уведомлений админу)" },
      ],
    });
    return json({ ok: r.ok, result: r, url });
  }

  if (action === "test") {
    const { settings } = await loadSalon();
    if (!settings.adminChatId) return json({ error: "Укажите ID чата для уведомлений в настройках" }, 400);
    const r = await tg("sendMessage", {
      chat_id: settings.adminChatId,
      text: "✅ Уведомления подключены. Сюда будут приходить новые заявки клиентов.",
    });
    return json({ ok: r.ok, result: r });
  }

  const [me, hook] = await Promise.all([tg("getMe", {}), tg("getWebhookInfo", {})]);
  return json({ ok: true, bot: me.result, webhook: hook.result });
}

async function handleUpdate(update, deadline) {
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const salon = await loadSalon();

  if (!msg.text) {
    await tg("sendMessage", { chat_id: chatId, text: "Пожалуйста, напишите ваш вопрос текстом 🙂" });
    return;
  }

  const cmd = msg.text.trim().split(/[\s@]/)[0];

  if (cmd === "/id") {
    await tg("sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: `ID этого чата: <code>${chatId}</code>\nВставьте его в админ-панели → Настройки → «ID чата для уведомлений».`,
    });
    return;
  }

  if (cmd === "/start" || cmd === "/new") {
    const welcome =
      `Здравствуйте${msg.from?.first_name ? ", " + msg.from.first_name : ""}! 👋\n` +
      `Я консультант салона косметологии «${salon.settings.salonName}». Помогу подобрать процедуру и записаться к специалисту.\n\n` +
      `Расскажите, что вас беспокоит или какого результата хотите добиться? Например: акне, пигментация, морщины, сухость кожи.`;
    // История должна начинаться с реплики клиента, поэтому сохраняем приветствие как ответ на /start
    await saveChatHistory(chatId, [
      { role: "user", parts: [{ text: "Здравствуйте" }] },
      { role: "model", parts: [{ text: welcome }] },
    ]);
    await tg("sendMessage", { chat_id: chatId, text: welcome });
    return;
  }

  if (deadline - Date.now() < 10000) {
    // Слишком долго ждали предыдущий ответ — честно просим повторить, а не молчим
    await tg("sendMessage", { chat_id: chatId, text: "Я ещё отвечала на предыдущее сообщение. Напишите, пожалуйста, это ещё раз 🙏" });
    return;
  }

  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  const typing = setInterval(() => tg("sendChatAction", { chat_id: chatId, action: "typing" }), 4500);

  try {
    const history = await getChatHistory(chatId);
    const createRequest = (args) => createRequestFromChat(args, msg, salon);
    const { contents, reply } = await runTurn({ history, userText: msg.text, salon, createRequest, deadline });
    await saveChatHistory(chatId, contents);
    for (const part of splitMessage(reply)) {
      await tg("sendMessage", { chat_id: chatId, text: part });
    }
  } catch (err) {
    console.error(err);
    const status = err?.status;
    const text =
      status === 429 ? "Сейчас много обращений, напишите, пожалуйста, через минуту."
      : "Произошла ошибка, попробуйте ещё раз чуть позже.";
    await tg("sendMessage", { chat_id: chatId, text });
  } finally {
    clearInterval(typing);
  }
}

const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

/** Ищет запись по названию: сначала точное совпадение, потом частичное (не короче 4 букв) */
function findByName(items, query, { firstWord = false } = {}) {
  const q = norm(query);
  if (!q) return null;
  const exact = items.find((x) => norm(x.name) === q);
  if (exact) return exact;
  if (q.length < 4) return null;
  const partial = items.filter((x) => {
    const name = norm(x.name);
    return name.includes(q) || q.includes(firstWord ? name.split(" ")[0] : name);
  });
  return partial.length === 1 ? partial[0] : null; // несколько вариантов — не угадываем
}

async function createRequestFromChat(args, msg, salon) {
  const phone = String(args.phone || "").trim();
  if (phone.replace(/\D/g, "").length < 7) {
    return { ok: false, error: "Номер телефона выглядит неполным, уточни его у клиента." };
  }

  const service = findByName(salon.services, args.service);
  if (!service) {
    return { ok: false, error: "Услуга не найдена. Уточни у клиента услугу и передай точное название из списка." };
  }
  const specialist = findByName(salon.specialists, args.specialist, { firstWord: true });

  // Клиент мог подтвердить заявку повторно (например, после сбоя) — не создаём дубль
  const chatId = msg.chat.id;
  const last = await getLastChatRequest(chatId);
  const digits = phone.replace(/\D/g, "");
  if (last && last.phone === digits && last.serviceId === service.id && Date.now() - last.at < 30 * 60 * 1000) {
    return { ok: true, request_id: last.id, specialist: last.specialist, service: service.name, note: "Эта заявка уже была создана" };
  }

  const request = {
    id: newRequestId(),
    createdAt: new Date().toISOString(),
    status: "new",
    name: String(args.name || "").trim(),
    phone,
    service: service.name,
    serviceId: service.id,
    priceFrom: service.priceFrom ?? null,
    currency: salon.settings.currency,
    specialist: specialist?.name || String(args.specialist || ""),
    specialistId: specialist?.id || null,
    preferredTime: String(args.preferred_time || ""),
    comment: String(args.comment || ""),
    telegram: {
      chatId: msg.chat.id,
      username: msg.from?.username || "",
      firstName: msg.from?.first_name || "",
    },
    history: [{ status: "new", at: new Date().toISOString(), by: "бот" }],
  };
  await saveRequest(request);
  await setLastChatRequest(chatId, {
    id: request.id, phone: digits, serviceId: service.id, specialist: request.specialist, at: Date.now(),
  });

  if (salon.settings.adminChatId) {
    await tg("sendMessage", {
      chat_id: salon.settings.adminChatId,
      text: requestMessage(request),
      parse_mode: "HTML",
    }).catch(() => {});
  }

  return { ok: true, request_id: request.id, specialist: request.specialist, service: request.service };
}

export const config = { path: "/api/bot" };
