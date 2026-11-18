import { GoogleGenAI } from "@google/genai";
import { price } from "./store.mjs";

// Основная модель — быстрая (отвечает за несколько секунд), запасная — на случай,
// если у основной закончился лимит или она перегружена
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash";
const MIN_CALL_MS = 6000; // меньше этого времени до конца лимита — новый запрос не начинаем
const MAX_HISTORY = 40;

export function buildSystemPrompt({ settings, services, specialists }) {
  const cur = settings.currency;
  const activeSpecialists = specialists.filter((s) => s.active !== false);
  const byId = Object.fromEntries(activeSpecialists.map((s) => [s.id, s]));

  const servicesText = services
    .filter((s) => s.active !== false)
    .map((s) => {
      const who = (s.specialistIds || []).map((id) => byId[id]?.name).filter(Boolean).join(", ") || "уточняется";
      return `- ${s.name} — ${price(s.priceFrom, cur)}, ~${s.duration} мин. ${s.description} Выполняет: ${who}.`;
    })
    .join("\n");

  const specialistsText = activeSpecialists
    .map((s) => `- ${s.name} — ${s.role}, ${s.experience}. ${s.about}`)
    .join("\n");

  return `Ты — администратор-консультант салона косметологии «${settings.salonName}» в Telegram. Твоя задача — помочь клиенту подобрать процедуру и оформить заявку на запись.

Как вести диалог:
1. Задавай по одному вопросу за раз. Сначала узнай, что беспокоит клиента или какого результата он хочет (например: акне, чёрные точки, пигментация, морщины, сухость, тусклый цвет лица, отёки, губы). Затем уточни 1–2 детали: тип кожи, делал(а) ли такие процедуры раньше, есть ли противопоказания (беременность, аллергия, обострение воспалений).
2. Предложи 1–3 подходящие услуги из списка ниже: коротко объясни, чем каждая поможет, назови цену в формате «от N ${cur}» и длительность.
3. Когда клиент выбрал услугу, обязательно скажи, какой специалист её выполняет: имя, должность и опыт.
4. Затем по очереди спроси имя, номер телефона и удобные дату и время.
5. Перед отправкой кратко повтори данные заявки и спроси подтверждение. Только после подтверждения вызови функцию create_request.
6. Когда заявка создана, сообщи клиенту её номер, что специалист или администратор свяжется для подтверждения времени, и что итоговая стоимость уточняется на консультации.

Правила:
- Предлагай только услуги и специалистов из списков ниже, не придумывай цены, услуги и скидки.
- Не ставь диагнозов и не давай медицинских назначений; при серьёзных проблемах кожи советуй очную консультацию косметолога.
- Отвечай кратко (2–5 предложений), тепло и вежливо, на языке клиента. Не используй Markdown (никаких звёздочек и решёток), эмодзи — умеренно.
- Если вопрос не о салоне, вежливо верни разговор к процедурам.

О салоне:
${settings.address ? `Адрес: ${settings.address}\n` : ""}Часы работы: ${settings.hours || "уточняйте у администратора"}
${settings.extraInfo || ""}

Услуги:
${servicesText}

Специалисты:
${specialistsText}`;
}

const CREATE_REQUEST_TOOL = {
  name: "create_request",
  description:
    "Создаёт заявку на запись в салон. Вызывай только после того, как клиент подтвердил услугу, специалиста, имя, телефон и удобное время.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Имя клиента" },
      phone: { type: "string", description: "Номер телефона клиента" },
      service: { type: "string", description: "Точное название услуги из списка" },
      specialist: { type: "string", description: "Имя специалиста из списка" },
      preferred_time: { type: "string", description: "Удобные дата и время, как сказал клиент" },
      comment: { type: "string", description: "Важные детали: проблема кожи, противопоказания, пожелания" },
    },
    required: ["name", "phone", "service", "specialist"],
  },
};

/**
 * Отправляет запрос в Gemini. Если у модели закончился лимит (429) — переходит на запасную,
 * если модель временно перегружена (500/503) — повторяет запрос.
 */
async function generateWithRetry(ai, { contents, config }, deadline) {
  const models = [...new Set([MODEL, FALLBACK_MODEL].filter(Boolean))];
  const left = () => deadline - Date.now();
  let lastErr = new Error("Не хватило времени на ответ");
  lastErr.status = 504;

  for (const [index, model] of models.entries()) {
    let history = contents;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (left() < MIN_CALL_MS) throw lastErr;
      try {
        return await ai.models.generateContent({
          model,
          contents: history,
          config: { ...config, abortSignal: AbortSignal.timeout(left() - 1000) },
        });
      } catch (err) {
        lastErr = err;
        // Запасная модель может не принять служебные подписи основной — убираем их и пробуем снова
        if (err?.status === 400 && index > 0 && history === contents) {
          history = stripSignatures(contents);
          continue;
        }
        if ([500, 503].includes(err?.status) && attempt === 1 && left() > MIN_CALL_MS + 1500) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        break; // лимит исчерпан, перегрузка или другая ошибка — пробуем следующую модель
      }
    }
  }
  throw lastErr;
}

const stripSignatures = (contents) =>
  contents.map((c) => ({ ...c, parts: (c.parts || []).map(({ thoughtSignature, ...p }) => p) }));

/** Обрезает историю, чтобы она всегда начиналась с текстового сообщения клиента */
function trimHistory(contents) {
  let out = contents.slice(-MAX_HISTORY);
  while (out.length && !(out[0].role === "user" && out[0].parts?.some((p) => typeof p.text === "string"))) {
    out = out.slice(1);
  }
  return out;
}

/**
 * Один ход диалога: отправляет сообщение клиента в Gemini, выполняет вызовы функций.
 * @returns {{ contents: object[], reply: string }}
 */
export async function runTurn({ history, userText, salon, createRequest, deadline = Date.now() + 50000 }) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const contents = [...history, { role: "user", parts: [{ text: userText }] }];
  const config = {
    systemInstruction: buildSystemPrompt(salon),
    tools: [{ functionDeclarations: [CREATE_REQUEST_TOOL] }],
    thinkingConfig: { thinkingLevel: "low" }, // быстрее отвечает в чате
  };
  // Завершает ход текстом бота, чтобы история никогда не обрывалась на служебной части
  const finish = (reply) => {
    contents.push({ role: "model", parts: [{ text: reply }] });
    return { contents: trimHistory(contents), reply };
  };

  for (let step = 0; step < 3; step++) {
    const res = await generateWithRetry(ai, { contents, config }, deadline);
    const content = res.candidates?.[0]?.content;
    if (!content?.parts?.length) {
      if (step === 0) {
        return { contents: trimHistory(contents.slice(0, -1)), reply: "Извините, не смогла ответить. Попробуйте переформулировать вопрос." };
      }
      return finish("Готово! Если остались вопросы — напишите.");
    }
    // Сохраняем ответ модели целиком (там служебные подписи, нужные для продолжения диалога)
    contents.push(content);

    const calls = res.functionCalls ?? [];
    if (!calls.length) {
      const text = content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
      return { contents: trimHistory(contents), reply: text || "…" };
    }

    const parts = [];
    for (const call of calls) {
      let result;
      try {
        result = call.name === "create_request" ? await createRequest(call.args ?? {}) : { error: "Неизвестная функция" };
      } catch (err) {
        console.error("Ошибка функции", call.name, err);
        result = { ok: false, error: "Не удалось сохранить заявку, попроси клиента повторить позже." };
      }
      parts.push({ functionResponse: { id: call.id, name: call.name, response: result } });
    }
    contents.push({ role: "user", parts });
  }

  return finish("Заявка обработана. Если остались вопросы — напишите!");
}
