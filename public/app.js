import { AUTO_MODEL, MIX_MIN_GAIN, MODELS, VARIABLES } from "/lib/config.js";

const $ = (sel, el = document) => el.querySelector(sel);
const nf1 = new Intl.NumberFormat("cs-CZ", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 0 });
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const PERIODS = [
  { days: 7, label: "7 dní" },
  { days: 30, label: "30 dní" },
  { days: 90, label: "90 dní" },
];
const LEAD_OPTS = [
  { leads: "1", label: "Na zítřek" },
  { leads: "1,2", label: "1–2 dny" },
  { leads: "3", label: "3 dny" },
  { leads: "5", label: "5 dní" },
];
const SORTS = [
  { by: "score", label: "Celkově" },
  { by: "temperature", label: "Teplota" },
  { by: "wind", label: "Vítr" },
  { by: "precipitation", label: "Srážky" },
];

// ---------- stav v URL (sdílitelný odkaz) ----------

const state = {
  place: null, // { name, lat, lon }
  days: 30,
  leads: "1,2",
  by: "score",
  data: null,
};

function readUrl() {
  const p = new URLSearchParams(location.search);
  const lat = Number(p.get("lat"));
  const lon = Number(p.get("lon"));
  if (p.has("lat") && Number.isFinite(lat) && Number.isFinite(lon)) {
    state.place = { name: p.get("name") || `${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon };
  }
  if (PERIODS.some((x) => String(x.days) === p.get("days"))) state.days = Number(p.get("days"));
  if (LEAD_OPTS.some((x) => x.leads === p.get("leads"))) state.leads = p.get("leads");
  if (SORTS.some((x) => x.by === p.get("by"))) state.by = p.get("by");
}

function writeUrl() {
  if (!state.place) return;
  const p = new URLSearchParams({
    name: state.place.name,
    lat: state.place.lat.toFixed(4),
    lon: state.place.lon.toFixed(4),
    days: String(state.days),
    leads: state.leads,
  });
  if (state.by !== "score") p.set("by", state.by);
  history.replaceState(null, "", `?${p}`);
}

// ---------- našeptávač ----------

const input = $("#q");
const list = $("#suggest");
let items = [];
let active = -1;
let session = newSession();
let timer = 0;
let seq = 0;

function newSession() {
  return crypto.randomUUID?.() ?? String(Math.random()).slice(2);
}

function openList(open) {
  list.hidden = !open;
  input.setAttribute("aria-expanded", String(open));
  if (!open) input.removeAttribute("aria-activedescendant");
}

function renderSuggest() {
  if (!items.length) {
    list.innerHTML = `<li class="empty" role="option" aria-disabled="true">Nic takového nenacházím. Zkuste jiný název.</li>`;
    openList(true);
    return;
  }
  list.innerHTML = items
    .map((it, i) => `<li id="sg-${i}" role="option" aria-selected="${i === active}" data-i="${i}">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</li>`)
    .join("");
  if (active >= 0) input.setAttribute("aria-activedescendant", `sg-${active}`);
  openList(true);
}

input.addEventListener("input", () => {
  clearTimeout(timer);
  const q = input.value.trim();
  if (q.length < 2) {
    items = [];
    openList(false);
    return;
  }
  timer = setTimeout(async () => {
    const my = ++seq;
    try {
      const r = await fetch(`/api/places?q=${encodeURIComponent(q)}&session=${session}`);
      const d = await r.json();
      if (my !== seq) return;
      items = d.items ?? [];
      active = items.length ? 0 : -1;
      renderSuggest();
    } catch {
      if (my !== seq) return;
      items = [];
      list.innerHTML = `<li class="empty" role="option" aria-disabled="true">Hledání teď nefunguje. Zkuste to za chvíli nebo použijte svoji polohu.</li>`;
      openList(true);
    }
  }, 220);
});

input.addEventListener("keydown", (e) => {
  if (list.hidden || !items.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    renderSuggest();
  } else if (e.key === "Enter" && active >= 0) {
    e.preventDefault();
    pick(items[active]);
  } else if (e.key === "Escape") {
    openList(false);
  }
});

list.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li) pick(items[Number(li.dataset.i)]);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#search")) openList(false);
});

async function pick(it) {
  openList(false);
  input.value = it.label;
  let place = it;
  if (it.lat == null) {
    try {
      const r = await fetch(`/api/place?id=${encodeURIComponent(it.id)}&session=${session}`);
      if (!r.ok) throw new Error();
      place = { ...it, ...(await r.json()) };
    } catch {
      showNotice("Místo se nepodařilo načíst", "Zkuste ho vybrat znovu.");
      return;
    }
  }
  session = newSession(); // Google účtuje hledání po relacích: výběr relaci končí
  setPlace({ name: place.label, lat: place.lat, lon: place.lon });
}

$("#quick").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-place]");
  if (!b) return;
  const [name, lat, lon] = b.dataset.place.split("|");
  input.value = name;
  setPlace({ name, lat: Number(lat), lon: Number(lon) });
});

$("#locate").addEventListener("click", () => {
  if (!navigator.geolocation) {
    showNotice("Poloha není k dispozici", "Tento prohlížeč polohu nesdílí. Napište místo do vyhledávání.");
    return;
  }
  showLoading("Zjišťuji polohu");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      input.value = "Moje poloha";
      setPlace({ name: "Moje poloha", lat: pos.coords.latitude, lon: pos.coords.longitude });
    },
    () => showNotice("Polohu se nepodařilo zjistit", "Povolte prohlížeči přístup k poloze, nebo napište místo do vyhledávání."),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
  );
});

function setPlace(place) {
  state.place = place;
  writeUrl();
  load();
}

// ---------- načtení a vykreslení ----------

const result = $("#result");

function showLoading(text) {
  result.innerHTML = `<p class="loading">${esc(text)}</p>`;
}

function showNotice(title, text) {
  result.innerHTML = `<div class="notice"><h2>${esc(title)}</h2><p>${esc(text)}</p></div>`;
}

async function load() {
  if (!state.place) return;
  const { lat, lon } = state.place;
  showLoading("Počítám srovnání");
  try {
    const r = await fetch(`/api/compare?lat=${lat}&lon=${lon}&days=${state.days}&leads=${state.leads}`);
    if (r.status === 503) {
      showNotice("Data zatím nejsou", "První noční výpočet ještě neproběhl. Zkuste to zítra.");
      return;
    }
    if (!r.ok) throw new Error(String(r.status));
    state.data = await r.json();
    render();
  } catch {
    showNotice("Srovnání se nepodařilo načíst", "Zkontrolujte připojení a zkuste to znovu.");
  }
}

const fmtDay = (iso) => {
  const [, m, d] = iso.split("-");
  return `${Number(d)}. ${Number(m)}.`;
};

function leadPhrase(leads) {
  return { "1": "na zítřek", "1,2": "na 1–2 dny", "3": "na 3 dny dopředu", "5": "na 5 dní dopředu" }[leads];
}

// Výškový rozdíl stanice proti místu, když je znát (od 50 m).
function elevNote(st) {
  if (st.elevDiff == null || Math.abs(st.elevDiff) < 50) return "";
  return `, o ${nf0.format(Math.abs(st.elevDiff))} m ${st.elevDiff > 0 ? "výš" : "níž"}`;
}

function sortValue(m) {
  return state.by === "score" ? m.score : m.rel?.[state.by] ?? -1;
}

// Stupeň barvy 1 (červená, nejhorší) až 5 (zelená, nejlepší), 0 = bez dat.
// Hodnocení jednoho dne je přísnější (nejlepší model dne má vždy 100, vítěz
// měsíce mívá v půlce dní kolem 78), proto má nižší hranice než celkové.
const BUCKETS = { total: [90, 80, 70, 60], day: [85, 75, 65, 55] };

function bucket(score, kind = "day") {
  if (score == null) return 0;
  const i = BUCKETS[kind].findIndex((x) => score >= x);
  return i === -1 ? 1 : 5 - i;
}

function tempStat(t) {
  if (!t) return `<dd>–<small>bez dat</small></dd>`;
  let bias = "";
  if (Math.abs(t.bias) >= 0.3) bias = `<small>spíš o ${nf1.format(Math.abs(t.bias))} °C ${t.bias > 0 ? "tepleji" : "chladněji"}</small>`;
  return `<dd>±${nf1.format(t.mae)} °C<small>${nf0.format(t.okPct)} % do ±2 °C</small>${bias}</dd>`;
}

function windStat(w) {
  if (!w) return `<dd>–<small>bez dat</small></dd>`;
  return `<dd>±${nf1.format(w.mae)} m/s<small>${nf0.format(w.okPct)} % do ±2 m/s</small></dd>`;
}

// Trefa (CSI) řadí modely; pod ní srozumitelněji, kolik hodin s deštěm
// model předem zachytil (zvlášť pro silnější déšť).
function precipStat(p) {
  if (!p || p.csi == null || p.wetHours < 5) return `<dd>–<small>málo deště k hodnocení</small></dd>`;
  const caught = p.pod != null ? `<small>zachytil ${nf0.format(p.pod)} % hodin s deštěm</small>` : "";
  const heavy = p.heavyPod != null && p.heavyHours >= 3
    ? `<small>a ${nf0.format(p.heavyPod)} % se silnějším (od 1 mm/h)</small>`
    : "";
  return `<dd>${nf0.format(p.csi)} %<small>trefa deště</small>${caught}${heavy}</dd>`;
}

function segment(name, legend, options, current, key) {
  return `<fieldset class="control"><legend>${legend}</legend><div class="seg" data-control="${name}">${options
    .map((o) => `<button type="button" data-v="${o[key]}" aria-pressed="${String(o[key]) === String(current)}">${o.label}</button>`)
    .join("")}</div></fieldset>`;
}

function render() {
  const d = state.data;
  const place = state.place;
  $("#updated").textContent = d.generated
    ? `Poslední výpočet ${new Date(d.generated).toLocaleString("cs-CZ", { dateStyle: "medium", timeStyle: "short" })}, data do ${fmtDay(d.window.end)}`
    : "";

  if (!d.stations.length) {
    showNotice(
      "Tady zatím neměříme",
      "Do 80 km od místa není žádná stanice, se kterou předpovědi porovnáváme. Ověřujeme zatím Česko a okolí.",
    );
    return;
  }
  if (!d.models.length) {
    showNotice("Málo dat", "Pro zvolené období a předstih zatím nemáme dost měření. Zkuste delší období.");
    return;
  }

  const top = d.models[0];
  const st = d.stations[0];
  const others = d.stations.length - 1;

  const models = [...d.models].sort((a, b) => sortValue(b) - sortValue(a));
  const shownDays = Math.min(14, d.window.days);

  result.innerHTML = `
    <div class="verdict">
      <p class="place">${esc(place.name)}</p>
      <p class="said">Za posledních ${d.window.days} dní se tu s předpovědí ${leadPhrase(state.leads)} nejvíc trefoval</p>
      <h2 class="winner">${esc(top.label)}</h2>
      ${mixBlock(d)}
      <p class="where">Měřeno na stanici ${esc(st.name)} (${st.distanceKm} km${elevNote(st)})${others > 0 ? ` a ${others} ${others === 1 ? "další" : "dalších"} v okolí` : ""}.</p>
    </div>

    <div class="controls">
      ${segment("days", "Období", PERIODS, state.days, "days")}
      ${segment("leads", "Předpověď", LEAD_OPTS, state.leads, "leads")}
      ${segment("by", "Seřadit", SORTS, state.by, "by")}
    </div>

    <ol class="ranking">
      ${models.map((m, i) => row(m, i, shownDays)).join("")}
    </ol>

    <div class="legend" aria-hidden="true">
      <span>Den po dni:</span>
      <span class="ramp"><i style="background:var(--s1)"></i><i style="background:var(--s2)"></i><i style="background:var(--s3)"></i><i style="background:var(--s4)"></i><i style="background:var(--s5)"></i></span>
      <span>od nejhoršího po nejlepší model dne</span>
    </div>
    ${missingNote(d)}
  `;
}

// Doporučený mix: model zvlášť pro každou veličinu. Jiný než Automaticky jen
// s jasným náskokem (MIX_MIN_GAIN), jinak by doporučení skákalo po šumu.
function mixBlock(d) {
  if (!d.mix) return "";
  const cells = Object.entries(VARIABLES).map(([k, v]) => {
    const g = d.mix[k];
    const picked = g && g.model !== AUTO_MODEL;
    let note = "málo dat";
    if (picked) note = g.gainPct != null ? `o ${nf0.format(g.gainPct)} % přesnější než Automaticky` : "Automaticky tu nemá data";
    else if (g && !Number.isFinite(MIX_MIN_GAIN[k])) note = "zatím vždy Automaticky";
    else if (g) note = "jiný model není výrazně lepší";
    return `<div${picked ? ' class="pick"' : ""}><dt>${v.label}</dt><dd>${esc(g?.label ?? "–")}<small>${note}</small></dd></div>`;
  });
  return `<p class="mix-title">Doporučený mix modelů</p><dl class="why">${cells.join("")}</dl>`;
}

function row(m, i, shownDays) {
  const value = sortValue(m);
  const isTop = m.id === state.data.models[0].id;
  const days = m.daily.slice(-shownDays);
  const bar = value >= 0 ? Math.max(2, Math.min(100, value)) : 0;
  const on = (k) => (state.by === k ? ' class="on"' : "");
  const scoreText = value >= 0 ? nf0.format(value) : "–";
  return `
    <li class="row${isTop ? " top" : ""}" data-model="${esc(m.id)}">
      <div class="row-head">
        <span class="rank">${value >= 0 ? i + 1 : ""}</span>
        <span class="name">${esc(m.label)}</span>
        <span class="score" aria-label="hodnocení ${scoreText} ze 100">${scoreText}<small>/100</small></span>
      </div>
      <div class="bar" aria-hidden="true"><span data-b="${bucket(value >= 0 ? value : null, "total")}" style="width:${bar}%"></span></div>
      <dl class="stats">
        <div${on("temperature")}><dt>Teplota</dt>${tempStat(m.temperature)}</div>
        <div${on("wind")}><dt>Vítr</dt>${windStat(m.wind)}</div>
        <div${on("precipitation")}><dt>Srážky</dt>${precipStat(m.precipitation)}</div>
      </dl>
      <div class="strip-wrap">
        <div class="strip-label">Posledních ${days.length} dní</div>
        <div class="strip">
          ${days
            .map((x) => {
              const txt = x.score == null
                ? `${fmtDay(x.day)}: bez dat`
                : `${fmtDay(x.day)}: hodnocení ${x.score}${x.tempMae != null ? `, teplota ±${nf1.format(x.tempMae)} °C` : ""} – klikněte pro průběh dne`;
              return `<button type="button" data-b="${bucket(x.score)}" data-day="${x.score == null ? "" : x.day}" data-tip="${esc(txt)}" aria-label="${esc(txt)}" aria-expanded="false"></button>`;
            })
            .join("")}
        </div>
        <p class="tip" aria-live="polite"></p>
        <div class="day-detail" hidden></div>
      </div>
    </li>`;
}

// ---------- detail dne: co model předpovídal a co se naměřilo ----------

const LEAD_TEXT = { 1: "vydaná den předem", 2: "vydaná 2 dny předem", 3: "vydaná 3 dny předem", 5: "vydaná 5 dní předem" };
const MODEL_BY = Object.fromEntries(MODELS.map((m) => [m.id, m]));
const CHARTS = [
  { k: "t", title: "Teplota", unit: "°C" },
  { k: "w", title: "Vítr", unit: "m/s" },
  { k: "p", title: "Srážky", unit: "mm za hodinu", bars: true },
];
const PAD = { l: 34, r: 8, t: 8, b: 20 };
let detail = null; // otevřený detail (pro hodnoty při najetí myší)

// Místní hodina (Praha) pro hodinu h dne počítaného v UTC.
const localHour = (day, h) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + h * 3_600_000)
    .toLocaleTimeString("cs-CZ", { hour: "numeric", timeZone: "Europe/Prague" });

function closeDays() {
  for (const c of result.querySelectorAll('.strip button[aria-expanded="true"]')) c.setAttribute("aria-expanded", "false");
  for (const p of result.querySelectorAll(".day-detail")) {
    p.hidden = true;
    p.innerHTML = "";
  }
  detail = null;
}

async function openDay(cell) {
  const wasOpen = cell.getAttribute("aria-expanded") === "true";
  closeDays();
  const day = cell.dataset.day;
  if (wasOpen || !day) return;
  const li = cell.closest(".row");
  const panel = li.querySelector(".day-detail");
  const model = li.dataset.model;
  const lead = Number(state.leads.split(",")[0]);
  cell.setAttribute("aria-expanded", "true");
  panel.hidden = false;
  panel.innerHTML = `<p class="loading">Načítám ${fmtDay(day)}</p>`;
  try {
    const { lat, lon } = state.place;
    const r = await fetch(`/api/day?lat=${lat}&lon=${lon}&day=${day}&model=${encodeURIComponent(model)}&lead=${lead}`);
    if (!r.ok) throw new Error(String(r.status));
    const data = await r.json();
    if (cell.getAttribute("aria-expanded") !== "true") return; // mezitím zavřeno
    if (!data.station) {
      panel.innerHTML = `<p class="dd-empty">Pro tento den nemáme měření po hodinách – ukládáme je od 2. 10. 2026.</p>`;
      return;
    }
    renderDay(panel, data, model);
  } catch {
    panel.innerHTML = `<p class="dd-empty">Průběh dne se nepodařilo načíst.</p>`;
  }
}

function renderDay(panel, data, model) {
  const series = [
    { key: "obs", label: "Naměřeno", cls: "obs" },
    { key: model, label: MODEL_BY[model]?.label ?? model, color: MODEL_BY[model]?.color },
    ...(model !== AUTO_MODEL ? [{ key: AUTO_MODEL, label: "Automaticky", cls: "auto" }] : []),
  ];
  const values = (s, k) => (s.key === "obs" ? data.observed[k] : data.forecast[s.key]?.[k]) ?? [];
  const width = Math.max(280, Math.round(panel.clientWidth - 24));
  detail = { data, series, values, width };
  const st = data.station;
  const fmt = (v, k) => (v == null ? "–" : v === -1 ? "pršelo" : `${nf1.format(v)}${k === "p" ? " mm" : k === "t" ? " °C" : " m/s"}`);
  panel.innerHTML = `
    <div class="dd-head">
      <p><strong>${fmtDay(data.day)}</strong> · předpověď ${LEAD_TEXT[data.lead]} · měřeno na stanici ${esc(st.name)} (${st.distanceKm} km${elevNote(st)})</p>
      <button type="button" class="dd-close" aria-label="Zavřít průběh dne">×</button>
    </div>
    <ul class="dd-legend">${series
      .map((s) => `<li><i class="sw ${s.cls ?? ""}"${s.color ? ` style="--c:${s.color}"` : ""}></i>${esc(s.label)}</li>`)
      .join("")}</ul>
    ${CHARTS.map((c) => chartSvg(c, series, values, data.day, width)).join("")}
    ${data.observed.p.includes(-1) ? `<p class="dd-note">Letiště hlásí jen, jestli pršelo, ne kolik – takové hodiny jsou označené tečkou.</p>` : ""}
    <p class="dd-note">Časy jsou místní; den počítáme v UTC, proto začíná od ${localHour(data.day, 0)}:00 místního času.</p>
    <details class="dd-table">
      <summary>Tabulka po hodinách</summary>
      <div class="dd-scroll"><table>
        <thead><tr><th>Hodina</th>${CHARTS.map((c) => `<th colspan="2">${c.title}</th>`).join("")}</tr>
          <tr><th></th>${CHARTS.map(() => `<th>naměřeno</th><th>${esc(series[1].label)}</th>`).join("")}</tr></thead>
        <tbody>${Array.from({ length: 24 }, (_, h) => `<tr><td>${localHour(data.day, h)} h</td>${CHARTS.map(
          (c) => `<td>${fmt(values(series[0], c.k)[h], c.k)}</td><td>${fmt(values(series[1], c.k)[h], c.k)}</td>`,
        ).join("")}</tr>`).join("")}</tbody>
      </table></div>
    </details>`;
}

const xAt = (h, width) => PAD.l + ((width - PAD.l - PAD.r) * (h + 0.5)) / 24;

function chartSvg(c, series, values, day, width) {
  const height = c.bars ? 96 : 128;
  const all = series.flatMap((s) => values(s, c.k)).filter((v) => v != null && v >= 0);
  let lo = c.bars ? 0 : Math.floor(Math.min(...all, Infinity));
  let hi = Math.ceil(Math.max(...all, c.bars ? 1 : -Infinity));
  if (!all.length || !Number.isFinite(lo)) [lo, hi] = [0, 1];
  if (!c.bars && hi - lo < 2) [lo, hi] = [lo - 1, hi + 1];
  const y = (v) => PAD.t + (height - PAD.t - PAD.b) * (1 - (v - lo) / (hi - lo));
  const ticks = [lo, (lo + hi) / 2, hi];
  const grid = ticks
    .map((t) => `<line class="grid" x1="${PAD.l}" x2="${width - PAD.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${PAD.l - 6}" y="${y(t) + 4}" text-anchor="end">${nf1.format(t).replace(",0", "")}</text>`)
    .join("");
  const xLabels = [0, 3, 6, 9, 12, 15, 18, 21]
    .map((h) => `<text class="axis" x="${xAt(h, width)}" y="${height - 4}" text-anchor="middle">${localHour(day, h)}</text>`)
    .join("");
  let marks = "";
  if (c.bars) {
    const slot = (width - PAD.l - PAD.r) / 24;
    const bw = Math.max(2, Math.min(7, (slot - 3) / series.length));
    series.forEach((s, i) => {
      values(s, c.k).forEach((v, h) => {
        const x = xAt(h, width) - (bw * series.length) / 2 + i * bw;
        if (v === -1) marks += `<circle class="wet ${s.cls ?? ""}" cx="${x + bw / 2}" cy="${y(0) - 4}" r="2.5"/>`;
        else if (v > 0) marks += `<rect class="${s.cls ?? ""}" x="${x}" y="${y(v)}" width="${bw - 1}" height="${Math.max(1, y(0) - y(v))}" rx="1"${s.color ? ` style="fill:${s.color}"` : ""}/>`;
      });
    });
  } else {
    for (const s of [...series].reverse()) {
      let d = "";
      let pen = false;
      values(s, c.k).forEach((v, h) => {
        if (v == null) return void (pen = false);
        d += `${pen ? "L" : "M"}${xAt(h, width).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      if (d) marks += `<path class="${s.cls ?? ""}" d="${d}"${s.color ? ` style="stroke:${s.color}"` : ""}/>`;
    }
  }
  const unmeasured = values(series[0], c.k).every((v) => v == null);
  const dry = c.bars && !unmeasured && !series.some((s) => values(s, c.k).some((v) => v === -1 || v > 0));
  const note = unmeasured ? " · stanice tuhle veličinu neměří" : dry ? " · nepršelo a modely déšť nečekaly" : "";
  return `
    <div class="dd-chart" data-k="${c.k}">
      <p class="dd-title">${c.title} <small>${c.unit}${note}</small></p>
      <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${c.title} po hodinách: naměřeno a předpověď">
        ${grid}${xLabels}${marks}
        <line class="cross" x1="0" x2="0" y1="${PAD.t}" y2="${height - PAD.b}" visibility="hidden"/>
      </svg>
      <div class="dd-tip" hidden></div>
    </div>`;
}

function showHour(ch, clientX) {
  if (!detail) return;
  const svg = ch.querySelector("svg");
  const rect = svg.getBoundingClientRect();
  const px = ((clientX - rect.left) / rect.width) * detail.width;
  const h = Math.max(0, Math.min(23, Math.floor(((px - PAD.l) / (detail.width - PAD.l - PAD.r)) * 24)));
  const k = ch.dataset.k;
  const x = xAt(h, detail.width);
  const cross = svg.querySelector(".cross");
  cross.setAttribute("x1", x);
  cross.setAttribute("x2", x);
  cross.setAttribute("visibility", "visible");
  const unit = k === "t" ? " °C" : k === "w" ? " m/s" : " mm";
  const tip = ch.querySelector(".dd-tip");
  tip.innerHTML = `<b>${localHour(detail.data.day, h)} h</b> ${detail.series
    .map((s) => {
      const v = detail.values(s, k)[h];
      return `<span>${esc(s.label)}: ${v == null ? "–" : v === -1 ? "pršelo" : nf1.format(v) + unit}</span>`;
    })
    .join("")}`;
  tip.hidden = false;
  const left = (x / detail.width) * rect.width;
  tip.style.left = `${Math.max(80, Math.min(rect.width - 80, left))}px`;
}

function hideHour(ch) {
  ch.querySelector(".cross")?.setAttribute("visibility", "hidden");
  const tip = ch.querySelector(".dd-tip");
  if (tip) tip.hidden = true;
}

function missingNote(d) {
  const shown = new Set(d.models.map((m) => m.id));
  const n = MODELS.length - shown.size;
  if (n <= 0) return "";
  return `<p class="missing">${n} ${n < 5 ? "modely tu nemají" : "modelů tu nemá"} dost dat – regionální modely obvykle nepokrývají toto místo nebo tak dlouhý předstih.</p>`;
}

// Ovládání a dlaždice dní (delegace – obsah se překresluje).
result.addEventListener("click", (e) => {
  const b = e.target.closest(".seg button");
  if (b) {
    const ctl = b.parentElement.dataset.control;
    const v = b.dataset.v;
    if (ctl === "days") state.days = Number(v);
    if (ctl === "leads") state.leads = v;
    if (ctl === "by") state.by = v;
    writeUrl();
    if (ctl === "by") render();
    else load();
    return;
  }
  const cell = e.target.closest(".strip button");
  if (cell) {
    cell.closest(".strip-wrap").querySelector(".tip").textContent = cell.dataset.tip;
    openDay(cell);
    return;
  }
  if (e.target.closest(".dd-close")) closeDays();
});

result.addEventListener("pointermove", (e) => {
  const ch = e.target.closest?.(".dd-chart");
  if (ch) showHour(ch, e.clientX);
});
result.addEventListener("pointerleave", (e) => {
  if (e.target.closest?.(".dd-chart")) hideHour(e.target.closest(".dd-chart"));
}, true);

for (const ev of ["mouseover", "focusin"]) {
  result.addEventListener(ev, (e) => {
    const cell = e.target.closest?.(".strip button");
    if (cell) cell.closest(".strip-wrap").querySelector(".tip").textContent = cell.dataset.tip;
  });
}

readUrl();
if (state.place) {
  input.value = state.place.name;
  load();
}
