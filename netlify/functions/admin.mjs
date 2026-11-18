import {
  json, isAdmin, loadSalon, listRequests, getRequest, saveRequest, deleteRequest,
  saveSettings, saveSpecialists, saveServices, STATUSES, tg,
} from "../lib/store.mjs";

/**
 * GET  /api/admin  — все данные для админ-панели
 * POST /api/admin  — { action, ... }: setStatus, deleteRequest, saveSettings, saveSpecialists, saveServices
 */
export default async (req) => {
  if (!isAdmin(req)) return json({ error: "Неверный пароль" }, 401);

  if (req.method === "GET") {
    const [salon, requests] = await Promise.all([loadSalon(), listRequests()]);
    return json({ ...salon, requests, statuses: STATUSES });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);

  switch (body.action) {
    case "setStatus": {
      const r = await getRequest(str(body.id, 40));
      if (!r) return json({ error: "Заявка не найдена" }, 404);
      if (!STATUSES[body.status]) return json({ error: "Неизвестный статус" }, 400);
      r.status = body.status;
      r.history = [...(r.history || []), { status: body.status, at: new Date().toISOString(), by: "админ" }];
      await saveRequest(r);
      if (body.notifyClient && r.telegram?.chatId && body.status === "booked") {
        await tg("sendMessage", {
          chat_id: r.telegram.chatId,
          text: `Ваша запись подтверждена ✅\nУслуга: ${r.service}\nСпециалист: ${r.specialist}${r.preferredTime ? `\nВремя: ${r.preferredTime}` : ""}\n\nЖдём вас!`,
        }).catch(() => {});
      }
      return json({ ok: true, request: r });
    }

    case "deleteRequest":
      await deleteRequest(str(body.id, 40));
      return json({ ok: true });

    case "saveSettings": {
      const s = body.settings || {};
      const settings = {
        salonName: str(s.salonName, 80) || "Салон",
        currency: str(s.currency, 8) || "₽",
        address: str(s.address, 200),
        hours: str(s.hours, 120),
        adminChatId: str(s.adminChatId, 30),
        extraInfo: str(s.extraInfo, 1500),
      };
      await saveSettings(settings);
      return json({ ok: true, settings });
    }

    case "saveSpecialists": {
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 50).map((s) => ({
        id: str(s.id, 40) || "sp-" + Math.random().toString(36).slice(2, 8),
        name: str(s.name, 80),
        role: str(s.role, 80),
        experience: str(s.experience, 80),
        about: str(s.about, 500),
        active: s.active !== false,
      })).filter((s) => s.name);
      await saveSpecialists(items);
      return json({ ok: true, items });
    }

    case "saveServices": {
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 100).map((s) => ({
        id: str(s.id, 40) || "sv-" + Math.random().toString(36).slice(2, 8),
        name: str(s.name, 100),
        priceFrom: Math.max(0, Math.round(Number(s.priceFrom) || 0)),
        duration: Math.max(0, Math.round(Number(s.duration) || 0)),
        description: str(s.description, 600),
        specialistIds: (Array.isArray(s.specialistIds) ? s.specialistIds : []).map((x) => str(x, 40)),
        active: s.active !== false,
      })).filter((s) => s.name);
      await saveServices(items);
      return json({ ok: true, items });
    }

    default:
      return json({ error: "Неизвестное действие" }, 400);
  }
};

export const config = { path: "/api/admin" };
