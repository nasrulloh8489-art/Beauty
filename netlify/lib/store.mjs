import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";
import { DEFAULT_SETTINGS, DEFAULT_SPECIALISTS, DEFAULT_SERVICES } from "./defaults.mjs";

export const STATUSES = {
  new: "Новая",
  contacted: "Связались",
  booked: "Записан",
  done: "Выполнена",
  canceled: "Отменена",
};

/* ---------------- База (Netlify Blobs) ---------------- */

const salonStore = () => getStore({ name: "salon", consistency: "strong" });
const requestsStore = () => getStore({ name: "requests", consistency: "strong" });
const chatsStore = () => getStore({ name: "chats", consistency: "strong" });
const updatesStore = () => getStore({ name: "tg-updates", consistency: "strong" });

async function getOrSeed(key, fallback) {
  const store = salonStore();
  const value = await store.get(key, { type: "json" });
  if (value) return value;
  await store.setJSON(key, fallback);
  return fallback;
}

export async function loadSalon() {
  const [settings, specialists, services] = await Promise.all([
    getOrSeed("settings", DEFAULT_SETTINGS),
    getOrSeed("specialists", DEFAULT_SPECIALISTS),
    getOrSeed("services", DEFAULT_SERVICES),
  ]);
  return { settings: { ...DEFAULT_SETTINGS, ...settings }, specialists, services };
}

export const saveSettings = (v) => salonStore().setJSON("settings", v);
export const saveSpecialists = (v) => salonStore().setJSON("specialists", v);
export const saveServices = (v) => salonStore().setJSON("services", v);

export async function listRequests() {
  const store = requestsStore();
  const { blobs } = await store.list();
  const all = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return all.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const getRequest = (id) => requestsStore().get(id, { type: "json" });
export const saveRequest = (r) => requestsStore().setJSON(r.id, r);
export const deleteRequest = (id) => requestsStore().delete(id);

export function newRequestId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `Z${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${rnd}`;
}

export const getChatHistory = async (chatId) =>
  (await chatsStore().get(String(chatId), { type: "json" })) ?? [];
export const saveChatHistory = (chatId, contents) => chatsStore().setJSON(String(chatId), contents);

/** Последняя заявка из чата — чтобы не создать дубль, если клиент подтвердит повторно */
const lastRequestsStore = () => getStore({ name: "chat-last-request", consistency: "strong" });
export const getLastChatRequest = (chatId) => lastRequestsStore().get(String(chatId), { type: "json" });
export const setLastChatRequest = (chatId, info) => lastRequestsStore().setJSON(String(chatId), info);

/** true, если это обновление Telegram уже обрабатывалось (защита от повторной доставки) */
export async function seenUpdate(updateId) {
  const store = updatesStore();
  const { modified } = await store.set(String(updateId), String(Date.now()), { onlyIfNew: true });
  // Изредка удаляем старые отметки, чтобы база не разрасталась
  if (modified && Math.random() < 0.02) {
    cleanupUpdates(store).catch(() => {});
  }
  return !modified;
}

async function cleanupUpdates(store) {
  const { blobs } = await store.list();
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  for (const b of blobs) {
    const at = Number(await store.get(b.key)) || 0;
    if (at < weekAgo) await store.delete(b.key);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Выполняет fn по очереди для одного чата: пока бот отвечает на одно сообщение,
 * следующее сообщение того же клиента ждёт, чтобы история диалога не перезаписалась.
 * Если очередь не подошла за maxWaitMs, fn всё равно выполняется (чтобы клиент получил ответ),
 * но чужая блокировка при этом не трогается.
 */
export async function withChatLock(chatId, fn, { maxWaitMs = 20000, staleMs = 65000 } = {}) {
  const store = getStore({ name: "chat-locks", consistency: "strong" });
  const key = String(chatId);
  const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const started = Date.now();
  let owned = false;

  while (Date.now() - started < maxWaitMs) {
    const { modified } = await store.set(key, token, { onlyIfNew: true });
    if (modified) { owned = true; break; }
    const current = await store.get(key);
    if (current == null) continue; // блокировку только что сняли — пробуем ещё раз
    const since = Number(String(current).split(":")[0]) || 0;
    if (Date.now() - since > staleMs && (await store.get(key)) === current) {
      await store.delete(key); // зависшая блокировка того же владельца
      continue;
    }
    await sleep(700);
  }

  try {
    return await fn();
  } finally {
    // Снимаем блокировку, только если она наша
    if (owned && (await store.get(key).catch(() => null)) === token) {
      await store.delete(key).catch(() => {});
    }
  }
}

/* ---------------- HTTP-хелперы ---------------- */

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export function isAdmin(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  const given = req.headers.get("x-admin-key") || "";
  if (!expected || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export const price = (n, cur) => `от ${Number(n).toLocaleString("ru-RU")} ${cur}`;

/* ---------------- Telegram ---------------- */

export const tgToken = () => process.env.TELEGRAM_BOT_TOKEN || "";

/** Секрет вебхука выводится из токена, чтобы не заводить отдельную переменную */
export const tgSecret = () => createHash("sha256").update("wh:" + tgToken()).digest("hex").slice(0, 48);

export async function tg(method, payload) {
  const token = tgToken();
  if (!token) return { ok: false, description: "TELEGRAM_BOT_TOKEN не задан" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    return await res.json().catch(() => ({ ok: false }));
  } catch (err) {
    // Сбой сети не должен ронять обработку сообщения
    console.error(`Telegram ${method}:`, err?.message);
    return { ok: false, description: String(err?.message || err) };
  }
}

/** Делит длинный текст на части по 4096 символов, не разрывая эмодзи */
export function splitMessage(text, limit = 4096) {
  const parts = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + limit, text.length);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1; // половинка эмодзи
    parts.push(text.slice(i, end));
    i = end;
  }
  return parts;
}

export function requestMessage(r) {
  const lines = [
    `<b>💆‍♀️ Новая заявка ${esc(r.id)}</b>`,
    "",
    `<b>Клиент:</b> ${esc(r.name)}`,
    `<b>Телефон:</b> ${esc(r.phone)}`,
  ];
  if (r.telegram?.username) lines.push(`<b>Telegram:</b> @${esc(r.telegram.username)}`);
  lines.push(`<b>Услуга:</b> ${esc(r.service)}${r.priceFrom ? ` (${esc(price(r.priceFrom, r.currency))})` : ""}`);
  lines.push(`<b>Специалист:</b> ${esc(r.specialist || "—")}`);
  if (r.preferredTime) lines.push(`<b>Удобное время:</b> ${esc(r.preferredTime)}`);
  if (r.comment) lines.push(`<b>Комментарий:</b> ${esc(r.comment)}`);
  return lines.join("\n");
}
