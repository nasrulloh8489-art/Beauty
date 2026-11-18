(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const KEY_NAME = "salon-admin-key";
  const storage = {
    get() { try { return sessionStorage.getItem(KEY_NAME) || ""; } catch { return ""; } },
    set(v) { try { sessionStorage.setItem(KEY_NAME, v); } catch {} },
    clear() { try { sessionStorage.removeItem(KEY_NAME); } catch {} },
  };

  let key = storage.get();
  let data = null;
  let filter = "new";

  function toast(text) {
    const el = $("#toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (el.hidden = true), 3000);
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: { "x-admin-key": key, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (res.status === 401) { logout(); throw new Error("Неверный пароль"); }
    if (!res.ok) throw new Error(out.error || `Ошибка ${res.status}`);
    return out;
  }

  /* ---------- Вход ---------- */

  function showLogin(error) {
    $("#app").hidden = true;
    $("#login").hidden = false;
    $("#loginError").hidden = !error;
    $("#loginError").textContent = error || "";
    $("#password").focus();
  }

  function logout() {
    key = "";
    storage.clear();
    showLogin();
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    key = $("#password").value;
    try {
      await load();
      storage.set(key);
    } catch (err) {
      showLogin(err.message);
    }
  });
  $("#logout").addEventListener("click", logout);

  /* ---------- Загрузка ---------- */

  async function load() {
    data = await api("/api/admin");
    $("#login").hidden = true;
    $("#app").hidden = false;
    $("#salonTitle").textContent = data.settings.salonName;
    renderRequests();
    renderSpecialists();
    renderServices();
    renderSettings();
  }

  /* ---------- Вкладки ---------- */

  $$(".tab").forEach((btn) =>
    btn.addEventListener("click", () => {
      $$(".tab").forEach((b) => b.classList.toggle("active", b === btn));
      $$(".panel").forEach((p) => (p.hidden = p.id !== "tab-" + btn.dataset.tab));
      if (btn.dataset.tab === "settings") loadBotInfo();
    })
  );

  /* ---------- Заявки ---------- */

  const fmtDate = (iso) =>
    new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const fmtPrice = (n, cur) => (n ? `от ${Number(n).toLocaleString("ru-RU")} ${cur || ""}` : "");

  function renderRequests() {
    const { requests, statuses } = data;
    const counts = requests.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});
    const newCount = counts.new || 0;
    $("#newCount").hidden = !newCount;
    $("#newCount").textContent = newCount;

    const chips = [["all", "Все", requests.length], ...Object.entries(statuses).map(([k, v]) => [k, v, counts[k] || 0])];
    $("#filters").innerHTML = chips
      .map(([k, label, n]) => `<button class="chip ${filter === k ? "active" : ""}" data-f="${k}">${esc(label)} · ${n}</button>`)
      .join("");
    $$("#filters .chip").forEach((c) => c.addEventListener("click", () => { filter = c.dataset.f; renderRequests(); }));

    const list = filter === "all" ? requests : requests.filter((r) => r.status === filter);
    if (!list.length) {
      $("#requests").innerHTML = `<div class="card empty">${requests.length ? "Нет заявок с этим статусом" : "Заявок пока нет. Они появятся, когда клиенты запишутся через бота."}</div>`;
      return;
    }

    $("#requests").innerHTML = list.map((r) => {
      const tgLink = r.telegram?.username
        ? `<a href="https://t.me/${esc(r.telegram.username)}" target="_blank" rel="noopener">@${esc(r.telegram.username)}</a>`
        : esc(r.telegram?.firstName || "—");
      const options = Object.entries(statuses)
        .map(([k, v]) => `<option value="${k}" ${r.status === k ? "selected" : ""}>${esc(v)}</option>`).join("");
      return `
        <article class="card req" data-id="${esc(r.id)}">
          <div class="req-head">
            <div>
              <div class="req-name">${esc(r.name || "Без имени")}</div>
              <div class="req-meta">${esc(r.id)} · ${fmtDate(r.createdAt)}</div>
            </div>
            <span class="status ${esc(r.status)}">${esc(statuses[r.status] || r.status)}</span>
          </div>
          <div class="req-grid">
            <div><span>Телефон</span><a href="tel:${esc(r.phone.replace(/[^\d+]/g, ""))}">${esc(r.phone)}</a></div>
            <div><span>Telegram</span>${tgLink}</div>
            <div><span>Услуга</span>${esc(r.service)} <span class="price">${esc(fmtPrice(r.priceFrom, r.currency))}</span></div>
            <div><span>Специалист</span>${esc(r.specialist || "—")}</div>
            <div><span>Удобное время</span>${esc(r.preferredTime || "—")}</div>
            ${r.comment ? `<div><span>Комментарий</span>${esc(r.comment)}</div>` : ""}
          </div>
          <div class="req-foot">
            <select class="st">${options}</select>
            <label class="check"><input type="checkbox" class="notify" checked> сообщить клиенту о записи</label>
            <button class="btn danger small del" style="margin-left:auto">Удалить</button>
          </div>
        </article>`;
    }).join("");

    $$("#requests .req").forEach((card) => {
      const id = card.dataset.id;
      $(".st", card).addEventListener("change", async (e) => {
        try {
          const { request } = await api("/api/admin", {
            action: "setStatus", id, status: e.target.value, notifyClient: $(".notify", card).checked,
          });
          Object.assign(data.requests.find((r) => r.id === id), request);
          toast(e.target.value === "booked" && $(".notify", card).checked ? "Статус обновлён, клиенту отправлено подтверждение" : "Статус обновлён");
          renderRequests();
        } catch (err) { toast(err.message); }
      });
      $(".del", card).addEventListener("click", async () => {
        if (!confirm("Удалить заявку безвозвратно?")) return;
        try {
          await api("/api/admin", { action: "deleteRequest", id });
          data.requests = data.requests.filter((r) => r.id !== id);
          renderRequests();
          toast("Заявка удалена");
        } catch (err) { toast(err.message); }
      });
    });
  }

  /** Обновляет только заявки — несохранённые правки услуг и специалистов не трогаются */
  async function refreshRequests() {
    const fresh = await api("/api/admin");
    data.requests = fresh.requests;
    renderRequests();
  }

  $("#refresh").addEventListener("click", () => refreshRequests().then(() => toast("Обновлено")).catch((e) => toast(e.message)));
  setInterval(() => { if (key && data && !document.hidden && !$("#tab-requests").hidden) refreshRequests().catch(() => {}); }, 30000);

  /* ---------- Специалисты ---------- */

  const uid = (p) => p + Math.random().toString(36).slice(2, 8);

  function renderSpecialists() {
    $("#specialists").innerHTML = data.specialists.map((s, i) => `
      <div class="card edit ${s.active === false ? "inactive" : ""}" data-i="${i}">
        <div class="form-grid">
          <label>Имя <input data-k="name" value="${esc(s.name)}"></label>
          <label>Должность <input data-k="role" value="${esc(s.role)}"></label>
          <label>Опыт <input data-k="experience" value="${esc(s.experience)}"></label>
          <label class="wide">О специалисте <textarea data-k="about" rows="2">${esc(s.about)}</textarea></label>
        </div>
        <div class="edit-foot">
          <label class="check"><input type="checkbox" data-k="active" ${s.active !== false ? "checked" : ""}> Принимает клиентов</label>
          <button class="btn danger small rm">Удалить</button>
        </div>
      </div>`).join("") || `<div class="card empty">Специалистов нет</div>`;
    bindEditor("#specialists", data.specialists, renderSpecialists);
  }

  $("#addSpecialist").addEventListener("click", () => {
    data.specialists.push({ id: uid("sp-"), name: "", role: "", experience: "", about: "", active: true });
    renderSpecialists();
  });
  $("#saveSpecialists").addEventListener("click", async () => {
    try {
      const { items } = await api("/api/admin", { action: "saveSpecialists", items: data.specialists });
      data.specialists = items;
      renderSpecialists();
      renderServices();
      toast("Специалисты сохранены");
    } catch (err) { toast(err.message); }
  });

  /* ---------- Услуги ---------- */

  function renderServices() {
    const cur = data.settings.currency;
    $("#services").innerHTML = data.services.map((s, i) => `
      <div class="card edit ${s.active === false ? "inactive" : ""}" data-i="${i}">
        <div class="form-grid">
          <label>Название <input data-k="name" value="${esc(s.name)}"></label>
          <label>Цена от, ${esc(cur)} <input data-k="priceFrom" type="number" min="0" step="100" value="${esc(s.priceFrom)}"></label>
          <label>Длительность, мин <input data-k="duration" type="number" min="0" step="5" value="${esc(s.duration)}"></label>
          <label class="wide">Описание (бот использует его, чтобы советовать) <textarea data-k="description" rows="2">${esc(s.description)}</textarea></label>
          <div class="wide"><label>Кто выполняет</label>
            <div class="checks">${data.specialists.map((sp) => `
              <label class="check"><input type="checkbox" data-sp="${esc(sp.id)}" ${(s.specialistIds || []).includes(sp.id) ? "checked" : ""}> ${esc(sp.name || "Без имени")}</label>`).join("")}
            </div>
          </div>
        </div>
        <div class="edit-foot">
          <label class="check"><input type="checkbox" data-k="active" ${s.active !== false ? "checked" : ""}> Показывать клиентам</label>
          <button class="btn danger small rm">Удалить</button>
        </div>
      </div>`).join("") || `<div class="card empty">Услуг нет</div>`;
    bindEditor("#services", data.services, renderServices);
    $$("#services [data-sp]").forEach((cb) =>
      cb.addEventListener("change", () => {
        const item = data.services[cb.closest("[data-i]").dataset.i];
        const set = new Set(item.specialistIds || []);
        cb.checked ? set.add(cb.dataset.sp) : set.delete(cb.dataset.sp);
        item.specialistIds = [...set];
      })
    );
  }

  $("#addService").addEventListener("click", () => {
    data.services.push({ id: uid("sv-"), name: "", priceFrom: 3000, duration: 60, description: "", specialistIds: [], active: true });
    renderServices();
  });
  $("#saveServices").addEventListener("click", async () => {
    try {
      const { items } = await api("/api/admin", { action: "saveServices", items: data.services });
      data.services = items;
      renderServices();
      toast("Услуги сохранены");
    } catch (err) { toast(err.message); }
  });

  /** Связывает поля карточек с массивом данных */
  function bindEditor(root, arr, rerender) {
    $$(`${root} [data-i]`).forEach((card) => {
      const item = arr[card.dataset.i];
      $$("[data-k]", card).forEach((input) =>
        input.addEventListener(input.type === "checkbox" ? "change" : "input", () => {
          const k = input.dataset.k;
          item[k] = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
          if (k === "active") card.classList.toggle("inactive", !input.checked);
        })
      );
      $(".rm", card).addEventListener("click", () => {
        if (!confirm("Удалить? Изменение сохранится после нажатия «Сохранить».")) return;
        arr.splice(card.dataset.i, 1);
        rerender();
      });
    });
  }

  /* ---------- Настройки ---------- */

  function renderSettings() {
    const f = $("#settingsForm");
    for (const [k, v] of Object.entries(data.settings)) if (f.elements[k]) f.elements[k].value = v ?? "";
  }

  $("#settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const settings = Object.fromEntries(new FormData(e.target));
    try {
      const out = await api("/api/admin", { action: "saveSettings", settings });
      data.settings = out.settings;
      $("#salonTitle").textContent = data.settings.salonName;
      renderServices();
      toast("Настройки сохранены");
    } catch (err) { toast(err.message); }
  });

  async function loadBotInfo() {
    const el = $("#botInfo");
    try {
      const { bot, webhook } = await api("/api/bot?action=info");
      const expected = location.origin + "/api/bot";
      const connected = webhook?.url === expected;
      el.innerHTML = `
        Бот: ${bot ? `<a href="https://t.me/${esc(bot.username)}" target="_blank" rel="noopener">@${esc(bot.username)}</a>` : "—"}<br>
        Вебхук: ${connected ? `<b style="color:var(--ok)">подключён к этому сайту</b>` : webhook?.url ? `указывает на другой адрес (${esc(webhook.url)})` : `<b style="color:var(--warn)">не подключён</b>`}
        ${webhook?.last_error_message ? `<br>Последняя ошибка: ${esc(webhook.last_error_message)}` : ""}`;
    } catch (err) {
      el.textContent = err.message;
    }
  }

  $("#setupBot").addEventListener("click", async () => {
    try {
      const r = await api("/api/bot?action=setup");
      toast(r.ok ? "Бот подключён к сайту" : "Не удалось: " + (r.result?.description || "ошибка"));
      loadBotInfo();
    } catch (err) { toast(err.message); }
  });
  $("#testBot").addEventListener("click", async () => {
    try {
      const r = await api("/api/bot?action=test");
      toast(r.ok ? "Отправлено — проверьте Telegram" : "Не отправлено: " + (r.result?.description || "ошибка"));
    } catch (err) { toast(err.message); }
  });

  /* ---------- Старт ---------- */
  if (key) load().catch(() => showLogin());
  else showLogin();
})();
