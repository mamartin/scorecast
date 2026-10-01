// Noční sběr: pro každou stanici a každý den porovná archivní předpovědi
// (Open-Meteo Previous Runs API) s měřením a uloží denní souhrny chyb po
// modelech a předstizích. Měření:
//   - stanice ČHMÚ v Česku (otevřená 10min data, ~300 stanic s teplotou),
//   - letištní METAR v Česku a okolí (Iowa Environmental Mesonet).
// Úhrn srážek: srážkoměr ČHMÚ, kde chybí (letiště, výpadek), radar ČHMÚ
// MERGE (archiv jen ~týden), jinak z METAR jen déšť ano/ne.
//
//   node scripts/collect.mjs                   doplní chybějící dny za BACKFILL_DAYS (35)
//   BACKFILL_DAYS=90 node scripts/collect.mjs  delší historie
//
// Dotazy na Open-Meteo jsou omezené rozpočtem OM_BUDGET (vážené dotazy, jak je
// počítá Open-Meteo). Nejdřív se plní nejnovější dny; co se nevejde, doplní
// další běh.
//
// Výstup: archive/<stanice>/station.json, archive/<stanice>/<RRRR-MM>.json
// (`days` = denní souhrny, `hours` = hodinová měření pro detail dne na webu,
// `empty` = dny, kdy stanice neměřila) a
// archive/_meta.json. Data pro API z nich připraví scripts/build-data.mjs.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAILY_DAYS, F, F_LEN, F_SUMS, HEAVY_MM, LEADS, MODELS, TEMP_OK, VARIABLES, WET_MM, WIND_OK, roundSum,
} from "../public/lib/config.js";
import { loadMerge, mergeHours } from "./radar.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// OUT_DIR jen pro testy (aby testovací data nepřepsala skutečná).
const OUT = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : root;
const ARCHIVE = resolve(OUT, "archive");

const SOURCES = (process.env.SOURCES ?? "chmi,metar").split(",");
const NETWORKS = (process.env.NETWORKS ?? "CZ__ASOS,SK__ASOS,AT__ASOS,DE__ASOS,PL__ASOS").split(",");
// Oblast ČR + okolí (pokrytí ALADIN a sousední regionální modely).
const BBOX = { minLat: 47.6, maxLat: 51.9, minLon: 11.0, maxLon: 19.9 };
// Stanice ČHMÚ jen v Česku (metadata obsahují i pár zahraničních).
const CZ_BBOX = { minLat: 48.5, maxLat: 51.1, minLon: 12.0, maxLon: 18.9 };
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS ?? 35);
const OM_BUDGET = Number(process.env.OM_BUDGET ?? 9000);
// Jen pro testy a zkoušky: kolik stanic vzít / každou kolikátou.
const STATION_LIMIT = Number(process.env.STATION_LIMIT ?? 0);
const STATION_STEP = Number(process.env.STATION_STEP ?? 1);
// Den musí mít aspoň tolik hodin měření, jinak ho přeskočíme (výpadek stanice).
const MIN_OBS_HOURS = 12;
// Den bez měření označíme jako prázdný až po této době (data mohou dorazit později).
const SETTLE_DAYS = 5;
const MAX_CHUNK_DAYS = 31;

const IEM_GEOJSON = (n) => `https://mesonet.agron.iastate.edu/geojson/network/${n}.geojson`;
const IEM_ASOS = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
const CHMI = "https://opendata.chmi.cz/meteorology/climate";
const PREVIOUS_RUNS = "https://previous-runs-api.open-meteo.com/v1/forecast";
const HEADERS = { "User-Agent": "scorecast/1.0 (+https://github.com/mamartin/scorecast)" };
const KNOT = 0.514444;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const hourKey = (t) => new Date(t).toISOString().slice(0, 13);
const compact = (day) => day.replaceAll("-", "");

async function fetchText(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.text();
      last = Object.assign(new Error(`HTTP ${res.status} ${url.slice(0, 120)}`), { status: res.status });
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      last = e;
    }
    // IEM při přetížení vrací 503 a krátká pauza nestačí: 5, 10, 20 s.
    if (i < tries - 1) await sleep(5000 * 2 ** i);
  }
  throw last;
}

async function fetchBuffer(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      last = Object.assign(new Error(`HTTP ${res.status} ${url.slice(0, 120)}`), { status: res.status });
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      last = e;
    }
    if (i < tries - 1) await sleep(2000 * 2 ** i);
  }
  throw last;
}

// Jako fetchText, ale chybějící soubor (404) vrací null.
async function fetchMaybe(url) {
  try {
    return await fetchText(url);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data) + "\n");
}

// Tabulka ČHMÚ { header: "A,B,…", values: [[…]] } → pole objektů.
function chmiTable(text) {
  const t = JSON.parse(text).data.data;
  const cols = t.header.split(",");
  return t.values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
}

// ---------- stanice ----------

async function loadMetarStations() {
  const out = [];
  for (const net of NETWORKS) {
    let gj;
    try {
      gj = JSON.parse(await fetchText(IEM_GEOJSON(net)));
    } catch (e) {
      console.warn(`stanice ${net}: ${e.message}`);
      continue;
    }
    for (const f of gj.features ?? []) {
      const [lon, lat] = f.geometry?.coordinates ?? [];
      const p = f.properties ?? {};
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < BBOX.minLat || lat > BBOX.maxLat || lon < BBOX.minLon || lon > BBOX.maxLon) continue;
      if (!/^[A-Z]{4}$/.test(p.sid ?? "")) continue; // jen ICAO kódy
      const elev = Number(p.elevation);
      out.push({
        id: p.sid,
        name: String(p.sname ?? p.sid),
        lat: +lat.toFixed(4),
        lon: +lon.toFixed(4),
        elev: Number.isFinite(elev) ? Math.round(elev) : null,
        src: "metar",
      });
    }
  }
  return out;
}

// Stanice ČHMÚ, které měří teplotu ve 2 m. Vítr bereme jen z čidel zhruba
// v 10 m (jako model), srážky ze srážkoměrů s 10min úhrnem.
async function loadChmiStations() {
  let m1;
  let m2;
  for (const t of [Date.now(), Date.now() - DAY]) {
    const d = compact(ymd(t));
    m1 = await fetchMaybe(`${CHMI}/now/metadata/meta1-${d}.json`);
    m2 = m1 && (await fetchMaybe(`${CHMI}/now/metadata/meta2-${d}.json`));
    if (m1 && m2) break;
  }
  if (!m1 || !m2) {
    console.warn("ČHMÚ: metadata stanic nejsou k dispozici");
    return [];
  }
  const sensors = new Map();
  for (const e of chmiTable(m2)) {
    if (e.OBS_TYPE !== "10M") continue;
    const s = sensors.get(e.WSI) ?? {};
    const h = Number(e.HEIGHT);
    if (e.EG_EL_ABBREVIATION === "T" && h >= 1.5 && h <= 2.6) s.t = true;
    if (e.EG_EL_ABBREVIATION === "F" && h >= 8 && h <= 13) s.wind = true;
    if (e.EG_EL_ABBREVIATION === "SRA10M") s.precip = true;
    sensors.set(e.WSI, s);
  }
  const out = [];
  for (const s of chmiTable(m1)) {
    const lat = Number(s.GEOGR2);
    const lon = Number(s.GEOGR1);
    const has = sensors.get(s.WSI);
    if (!has?.t || !/^[A-Z0-9]+$/.test(s.GH_ID ?? "")) continue;
    if (lat < CZ_BBOX.minLat || lat > CZ_BBOX.maxLat || lon < CZ_BBOX.minLon || lon > CZ_BBOX.maxLon) continue;
    const elev = Number(s.ELEVATION);
    out.push({
      id: s.GH_ID,
      wsi: s.WSI,
      name: String(s.FULL_NAME),
      lat: +lat.toFixed(4),
      lon: +lon.toFixed(4),
      elev: Number.isFinite(elev) ? Math.round(elev) : null,
      src: "chmi",
      wind: Boolean(has.wind),
      precip: Boolean(has.precip),
    });
  }
  return out;
}

// ---------- měření ----------

// Kódy počasí METAR, které znamenají padající srážky (VC = jen v okolí → ne).
function isPrecip(wx) {
  if (!wx || wx === "M") return false;
  return wx.split(/\s+/).some((tok) => {
    const t = tok.replace(/^[+-]/, "");
    if (!t || t.startsWith("VC")) return false;
    return /(DZ|RA|SN|SG|PL|GR|GS|UP|IC)/.test(t);
  });
}

// Hodinové sloty měření: hodina (UTC, "YYYY-MM-DDTHH") → { t, w, reports, wet }.
// Teplota a vítr k celé hodině; srážky za předchozí hodinu (H-60, H] –
// stejně jako Open-Meteo počítá srážky za předchozí hodinu.
function hourSlots() {
  const hours = new Map();
  const slot = (k) => {
    let h = hours.get(k);
    // reports > 0 = srážky v té hodině hodnotíme (wet), mmKnown = známe i úhrn (mm).
    if (!h) hours.set(k, (h = { t: null, tD: Infinity, w: null, wD: Infinity, reports: 0, wet: false, mm: 0, mmKnown: false }));
    return h;
  };
  return { hours, slot };
}

// METAR: teplota a vítr ze zprávy nejbližší celé hodině (±10 min); srážky =
// zda některá zpráva v předchozí hodině hlásila padající srážky.
async function loadMetarObservations(station, fromMs, toMs) {
  const s = new Date(fromMs);
  const e = new Date(toMs);
  const p = new URLSearchParams({
    station: station.id,
    year1: String(s.getUTCFullYear()), month1: String(s.getUTCMonth() + 1), day1: String(s.getUTCDate()),
    year2: String(e.getUTCFullYear()), month2: String(e.getUTCMonth() + 1), day2: String(e.getUTCDate()),
    tz: "Etc/UTC", format: "onlycomma", latlon: "no", elev: "no",
    missing: "M", trace: "T", direct: "no",
  });
  for (const d of ["tmpc", "sknt", "wxcodes"]) p.append("data", d);
  p.append("report_type", "3");
  p.append("report_type", "4");
  const text = await fetchText(`${IEM_ASOS}?${p}`);

  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  const header = (lines.shift() ?? "").split(",");
  const iValid = header.indexOf("valid");
  const iT = header.indexOf("tmpc");
  const iW = header.indexOf("sknt");
  const iWx = header.indexOf("wxcodes");
  const { hours, slot } = hourSlots();
  if (iValid < 0) return { hours, unavailable: new Set() };

  for (const line of lines) {
    const c = line.split(",");
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(c[iValid] ?? "");
    if (!m) continue;
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`);

    const ps = slot(hourKey(Math.ceil(t / 3_600_000) * 3_600_000));
    ps.reports++;
    if (iWx >= 0 && isPrecip(c[iWx])) ps.wet = true;

    const near = Math.round(t / 3_600_000) * 3_600_000;
    const diff = Math.abs(t - near);
    if (diff > 10 * 60_000) continue;
    const ns = slot(hourKey(near));
    const temp = Number(c[iT]);
    if (iT >= 0 && c[iT] !== "M" && Number.isFinite(temp) && diff < ns.tD) {
      ns.t = temp;
      ns.tD = diff;
    }
    const wind = Number(c[iW]);
    if (iW >= 0 && c[iW] !== "M" && Number.isFinite(wind) && diff < ns.wD) {
      ns.w = wind * KNOT;
      ns.wD = diff;
    }
  }
  return { hours, unavailable: new Set() };
}

// ČHMÚ: posledních pár dní leží v now/ (soubor na den), starší v recent/
// (soubor na měsíc, vychází začátkem dalšího měsíce). Měsíční soubory mají
// kolem 5 MB, proto je držíme v paměti jen pro právě zpracovávanou stanici.
const CHMI_ELEMENTS = new Set(["T", "F", "SRA10M"]);
let chmiMonths = { station: null, cache: new Map() };

function chmiRows(text) {
  return chmiTable(text).filter((r) => CHMI_ELEMENTS.has(r.ELEMENT));
}

async function chmiDayRows(station, day) {
  const today = ymd(Date.now());
  if (day >= ymd(Date.now() - 2 * DAY) && day <= today) {
    const text = await fetchMaybe(`${CHMI}/now/data/10m-${station.wsi}-${compact(day)}.json`);
    if (text) return chmiRows(text);
  }
  if (chmiMonths.station !== station.id) chmiMonths = { station: station.id, cache: new Map() };
  const month = day.slice(0, 7);
  if (!chmiMonths.cache.has(month)) {
    const url = `${CHMI}/recent/data/10min/${month.slice(5)}/10m-${station.wsi}-${compact(month)}.json`;
    const text = await fetchMaybe(url);
    const byDay = new Map();
    if (text) {
      for (const r of chmiRows(text)) {
        const d = String(r.DT).slice(0, 10);
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(r);
      }
    }
    chmiMonths.cache.set(month, text ? byDay : null);
  }
  const byDay = chmiMonths.cache.get(month);
  return byDay ? byDay.get(day) ?? [] : null;
}

async function loadChmiObservations(station, fromMs, toMs) {
  const { hours, slot } = hourSlots();
  const unavailable = new Set();
  // Srážky v hodině 00 potřebují i 23:10–23:50 předchozího dne.
  for (let t = fromMs - DAY; t <= toMs; t += DAY) {
    const day = ymd(t);
    const rows = await chmiDayRows(station, day);
    if (rows == null) {
      if (t >= fromMs) unavailable.add(day);
      continue;
    }
    for (const r of rows) {
      const ts = Date.parse(r.DT);
      const v = Number(r.VAL);
      if (!Number.isFinite(ts) || r.VAL == null || r.VAL === "" || !Number.isFinite(v)) continue;
      if (r.ELEMENT === "SRA10M") {
        // Úhrn za 10 minut končících v DT → patří k hodině, ve které interval končí.
        if (v < 0 || v > 100) continue;
        const s = slot(hourKey(Math.ceil(ts / 3_600_000) * 3_600_000));
        s.reports++;
        s.mm += v;
        continue;
      }
      if (ts % 3_600_000 !== 0) continue; // teplota a vítr jen k celé hodině
      const s = slot(hourKey(ts));
      if (r.ELEMENT === "T" && v > -60 && v < 60) s.t = v;
      if (r.ELEMENT === "F" && station.wind && v >= 0 && v < 80) s.w = v;
    }
  }
  for (const s of hours.values()) {
    // Srážky hodnotíme jen při (téměř) úplné hodině 10min úhrnů.
    if (!station.precip || s.reports < 5) s.reports = 0;
    s.mmKnown = s.reports > 0;
    s.wet = s.mm >= WET_MM;
  }
  return { hours, unavailable };
}

// Doplní úhrn z radaru do hodin, kde ho neznáme ze srážkoměru (METAR hlásí
// jen déšť ano/ne, srážkoměr mohl vypadnout).
function applyRadar(hours, byHour, fromMs, toMs) {
  if (!byHour) return;
  for (const [k, mm] of byHour) {
    const t = Date.parse(`${k}:00Z`);
    if (t < fromMs || t >= toMs + DAY) continue;
    let s = hours.get(k);
    if (!s) hours.set(k, (s = { t: null, w: null, reports: 0, wet: false, mm: 0, mmKnown: false }));
    if (s.mmKnown) continue; // srážkoměr má přednost
    s.mm = mm;
    s.mmKnown = true;
    s.reports = Math.max(s.reports, 1);
    s.wet = mm >= WET_MM;
  }
}

// Hodinová měření dne pro detail na webu: t (°C), w (m/s), p (mm; -1 = pršelo,
// ale úhrn neznáme – METAR), null = v té hodině neměřeno.
function hourlyObs(hours, day) {
  const t = [];
  const w = [];
  const p = [];
  for (let h = 0; h < 24; h++) {
    const o = hours.get(`${day}T${String(h).padStart(2, "0")}`);
    t.push(o?.t ?? null);
    w.push(o?.w == null ? null : Math.round(o.w * 10) / 10);
    p.push(!o?.reports ? null : o.mmKnown ? Math.round(o.mm * 10) / 10 : o.wet ? -1 : 0);
  }
  return { t, w, p };
}

// ---------- předpovědi ----------

const FORECAST_VARS = Object.values(VARIABLES).flatMap((v) =>
  LEADS.map((d) => `${v.om}_previous_day${d}`),
);

// Open-Meteo počítá dotaz s víc než 10 proměnnými nebo 2 týdny dat jako víc
// dotazů a zdarma povoluje 600 za minutu, 5 000 za hodinu a 10 000 za den.
let omSpent = 0;
const omCost = (nVars, nDays) => Math.max(1, nVars / 10) * Math.max(1, nDays / 14);
const OM_PER_MINUTE = Number(process.env.OM_PER_MINUTE ?? 550);
const OM_PER_HOUR = Number(process.env.OM_PER_HOUR ?? 4800);
const omLog = []; // [čas, váha] odeslaných dotazů

// Počká, až se dotaz s danou váhou vejde do minutového i hodinového limitu.
async function omThrottle(cost) {
  for (;;) {
    const now = Date.now();
    while (omLog.length && omLog[0][0] < now - 3_600_000) omLog.shift();
    const used = (ms) => omLog.reduce((s, [t, c]) => (t >= now - ms ? s + c : s), 0);
    const overMin = used(60_000) + cost > OM_PER_MINUTE;
    const overHour = used(3_600_000) + cost > OM_PER_HOUR;
    if (!overMin && !overHour) break;
    // Počkat, až vypadne nejstarší dotaz z příslušného okna.
    const oldest = omLog.find(([t]) => t >= now - (overHour ? 3_600_000 : 60_000));
    await sleep(Math.max(1000, oldest[0] + (overHour ? 3_600_000 : 60_000) - now + 50));
  }
  omLog.push([Date.now(), cost]);
  omSpent += cost;
}

// Jeden dotaz na všechny modely; když ho Open-Meteo odmítne (některý model
// tu nemá data), zkusí modely po jednom. Vrací { times, series }.
async function loadForecasts(station, startDay, endDay) {
  const nDays = (Date.parse(endDay) - Date.parse(startDay)) / DAY + 1;
  const query = (ms) => {
    const p = new URLSearchParams({
      latitude: String(station.lat),
      longitude: String(station.lon),
      hourly: FORECAST_VARS.join(","),
      models: ms.join(","),
      start_date: startDay,
      end_date: endDay,
      timezone: "GMT",
      wind_speed_unit: "ms",
    });
    // Teplotu přepočítat na skutečnou výšku stanice, ne průměr buňky modelu.
    if (station.elev != null) p.set("elevation", String(station.elev));
    return `${PREVIOUS_RUNS}?${p}`;
  };
  const parse = (text) =>
    JSON.parse(text.replace(/\bNaN\b/g, "null").replace(/-?Infinity/g, "null")).hourly ?? {};

  const ids = MODELS.map((m) => m.id);
  let times = [];
  const series = {}; // model → var → hodnoty
  try {
    await omThrottle(omCost(FORECAST_VARS.length * ids.length, nDays));
    const h = parse(await fetchText(query(ids)));
    times = h.time ?? [];
    for (const m of ids) {
      series[m] = {};
      for (const v of FORECAST_VARS) series[m][v] = h[`${v}_${m}`] ?? [];
    }
  } catch (e) {
    console.warn(`  ${station.id}: hromadný dotaz selhal (${e.message}), zkouším po modelech`);
    for (const m of ids) {
      try {
        await omThrottle(omCost(FORECAST_VARS.length, nDays));
        const h = parse(await fetchText(query([m]), 1));
        if (h.time?.length) times = h.time;
        series[m] = {};
        // Při jednom modelu Open-Meteo příponu nepřidává.
        for (const v of FORECAST_VARS) series[m][v] = h[`${v}_${m}`] ?? h[v] ?? [];
      } catch {
        /* model tu nemá data */
      }
      await sleep(300);
    }
  }
  return { times, series };
}

// ---------- výpočet ----------

// Kolik hodin s teplotou má který den.
function obsHoursPerDay(obs) {
  const n = new Map();
  for (const [k, o] of obs) {
    if (o.t != null) n.set(k.slice(0, 10), (n.get(k.slice(0, 10)) ?? 0) + 1);
  }
  return n;
}

function scoreDays(obs, fc) {
  const days = {}; // den → model → předstih → pole F
  const perDay = obsHoursPerDay(obs);
  const vT = VARIABLES.temperature.om;
  const vW = VARIABLES.wind.om;
  const vP = VARIABLES.precipitation.om;

  fc.times.forEach((time, i) => {
    const key = String(time).slice(0, 13);
    const day = key.slice(0, 10);
    if ((perDay.get(day) ?? 0) < MIN_OBS_HOURS) return;
    const o = obs.get(key);
    if (!o) return;
    for (const [model, s] of Object.entries(fc.series)) {
      for (const d of LEADS) {
        const ft = s[`${vT}_previous_day${d}`]?.[i];
        const fw = s[`${vW}_previous_day${d}`]?.[i];
        const fp = s[`${vP}_previous_day${d}`]?.[i];
        if (ft == null && fw == null && fp == null) continue;
        const byModel = (days[day] ??= {});
        const byLead = (byModel[model] ??= {});
        const a = (byLead[d] ??= new Array(F_LEN).fill(0));
        if (ft != null && o.t != null) {
          const e = ft - o.t;
          a[F.tN]++; a[F.tAbs] += Math.abs(e); a[F.tSum] += e;
          if (Math.abs(e) <= TEMP_OK) a[F.tOk]++;
        }
        if (fw != null && o.w != null) {
          const e = fw - o.w;
          a[F.wN]++; a[F.wAbs] += Math.abs(e); a[F.wSum] += e;
          if (Math.abs(e) <= WIND_OK) a[F.wOk]++;
        }
        if (fp != null && o.reports > 0) {
          const fWet = fp >= WET_MM;
          if (fWet && o.wet) a[F.hit]++;
          else if (!fWet && o.wet) a[F.miss]++;
          else if (fWet && !o.wet) a[F.fa]++;
          else a[F.cn]++;
        }
        if (fp != null && o.mmKnown) {
          const e = fp - o.mm;
          a[F.pN]++; a[F.pAbs] += Math.abs(e); a[F.pSum] += e;
          const f1 = fp >= HEAVY_MM;
          const o1 = o.mm >= HEAVY_MM;
          if (f1 && o1) a[F.hit1]++;
          else if (!f1 && o1) a[F.miss1]++;
          else if (f1 && !o1) a[F.fa1]++;
        }
      }
    }
  });

  // Zaokrouhlit součty (úspora místa) a vyhodit prázdné záznamy.
  for (const byModel of Object.values(days)) {
    for (const [model, byLead] of Object.entries(byModel)) {
      for (const [d, a] of Object.entries(byLead)) {
        if (!a.some((x) => x)) delete byLead[d];
        else for (const j of F_SUMS) a[j] = roundSum(j, a[j]);
      }
      if (!Object.keys(byLead).length) delete byModel[model];
    }
  }
  return days;
}

// ---------- archiv ----------

const monthPath = (id, month) => resolve(ARCHIVE, id, `${month}.json`);

function monthsIn(fromMs, toMs) {
  const out = [];
  for (let t = fromMs; t <= toMs; t += DAY) {
    const m = ymd(t).slice(0, 7);
    if (out.at(-1) !== m) out.push(m);
  }
  return out;
}

// Souvislé úseky chybějících dní (nejvýš MAX_CHUNK_DAYS) → méně dotazů.
function missingChunks(known, fromMs, toMs) {
  const chunks = [];
  let cur = null;
  for (let t = fromMs; t <= toMs; t += DAY) {
    if (known.has(ymd(t))) {
      cur = null;
      continue;
    }
    if (cur && cur.end === t - DAY && (t - cur.start) / DAY < MAX_CHUNK_DAYS) cur.end = t;
    else chunks.push((cur = { start: t, end: t }));
  }
  return chunks;
}

const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

async function saveMonths(w) {
  for (const m of w.dirty) {
    const mo = w.months.get(m);
    await writeJson(monthPath(w.st.id, m), {
      days: sortKeys(mo.days),
      empty: [...new Set(mo.empty)].sort(),
      hours: sortKeys(mo.hours),
    });
  }
  w.dirty.clear();
}

async function main() {
  const stations = [
    ...(SOURCES.includes("chmi") ? await loadChmiStations() : []),
    ...(SOURCES.includes("metar") ? await loadMetarStations() : []),
  ];
  const sampled = stations.filter((_, i) => i % STATION_STEP === 0);
  const list = STATION_LIMIT ? sampled.slice(0, STATION_LIMIT) : sampled;
  const today = Date.parse(ymd(Date.now()));
  const last = today - DAY; // včerejšek – poslední den s kompletním měřením
  const first = last - (BACKFILL_DAYS - 1) * DAY;
  const settled = ymd(last - SETTLE_DAYS * DAY);
  const counts = list.reduce((a, s) => ({ ...a, [s.src]: (a[s.src] ?? 0) + 1 }), {});
  console.log(`Stanic: ${list.length} (${JSON.stringify(counts)}), dny ${ymd(first)} – ${ymd(last)}, rozpočet Open-Meteo ${OM_BUDGET}`);

  // Archiv každé stanice za sledované období a chybějící úseky.
  const work = [];
  for (const st of list) {
    const months = new Map();
    for (const m of monthsIn(first, last)) {
      months.set(m, { days: {}, empty: [], hours: {}, ...(await readJson(monthPath(st.id, m), {})) });
    }
    const known = new Set();
    for (const mo of months.values()) {
      for (const d of Object.keys(mo.days)) known.add(d);
      for (const d of mo.empty ?? []) known.add(d);
    }
    await writeJson(resolve(ARCHIVE, st.id, "station.json"), st);
    work.push({ st, months, chunks: missingChunks(known, first, last), dirty: new Set() });
  }

  // Radar za hodiny ve sledovaném období (archiv má jen ~týden).
  let radar = new Map();
  {
    try {
      const hours = (await mergeHours(fetchText)).filter((t) => t >= first && t < last + DAY);
      const r = await loadMerge(list, hours, fetchBuffer);
      radar = r.series;
      console.log(`Radar MERGE: ${r.loaded} hodinových snímků, ${radar.size} stanic v dosahu`);
    } catch (e) {
      console.warn(`Radar MERGE: ${e.message}`);
    }
  }

  // Nejdřív poslední dny všech stanic, pak starší úseky od nejnovějších.
  const recent = last - 2 * DAY;
  const tasks = [
    ...work.flatMap((w) => w.chunks.filter((c) => c.end >= recent).map((c) => ({ w, c }))),
    ...work.flatMap((w) => w.chunks.filter((c) => c.end < recent).reverse().map((c) => ({ w, c }))),
  ];
  const fullCost = (nDays) => omCost(FORECAST_VARS.length * MODELS.length, nDays);
  let added = 0;
  let skipped = 0;
  for (const { w, c } of tasks) {
    const { st } = w;
    const nDays = (c.end - c.start) / DAY + 1;
    if (omSpent + fullCost(nDays) > OM_BUDGET) {
      skipped++;
      continue;
    }
    try {
      const obs = st.src === "chmi"
        ? await loadChmiObservations(st, c.start, c.end)
        : await loadMetarObservations(st, c.start - DAY, c.end + DAY);
      applyRadar(obs.hours, radar.get(st.id), c.start, c.end);
      // Předpovědi stahujeme jen pro dny, které mají dost měření.
      const perDay = obsHoursPerDay(obs.hours);
      const good = [];
      for (let t = c.start; t <= c.end; t += DAY) {
        const d = ymd(t);
        if ((perDay.get(d) ?? 0) >= MIN_OBS_HOURS) good.push(d);
        else if (!obs.unavailable.has(d) && d <= settled) {
          w.months.get(d.slice(0, 7)).empty.push(d); // stanice ten den neměřila
          w.dirty.add(d.slice(0, 7));
        }
      }
      if (good.length) {
        const fc = await loadForecasts(st, good[0], good.at(-1));
        const days = scoreDays(obs.hours, fc);
        for (const d of good) {
          if (!days[d]) continue;
          const mo = w.months.get(d.slice(0, 7));
          mo.days[d] = days[d];
          mo.hours[d] = hourlyObs(obs.hours, d);
          w.dirty.add(d.slice(0, 7));
          added++;
        }
      }
      console.log(`  ${st.id} ${st.name}: ${ymd(c.start)}–${ymd(c.end)} → ${good.length} dní s měřením`);
    } catch (e) {
      console.warn(`  ${st.id}: ${e.message}`);
    }
    await saveMonths(w); // hned, ať se při pádu běhu neztratí hotová práce
    await sleep(st.src === "chmi" ? 100 : 400); // šetrně k bezplatným API
  }

  // Hodinová měření pro detail dne doplníme i k posledním dnům, které je
  // ještě nemají (bez dotazů na Open-Meteo).
  const detailFrom = ymd(last - (DAILY_DAYS - 1) * DAY);
  let detailed = 0;
  for (const w of work) {
    const need = [...w.months.values()]
      .flatMap((mo) => Object.keys(mo.days).filter((d) => d >= detailFrom && !mo.hours[d]))
      .sort();
    if (!need.length) continue;
    const from = Date.parse(need[0]);
    const to = Date.parse(need.at(-1));
    try {
      const obs = w.st.src === "chmi"
        ? await loadChmiObservations(w.st, from, to)
        : await loadMetarObservations(w.st, from - DAY, to + DAY);
      applyRadar(obs.hours, radar.get(w.st.id), from, to);
      for (const d of need) {
        if (obs.unavailable.has(d)) continue;
        w.months.get(d.slice(0, 7)).hours[d] = hourlyObs(obs.hours, d);
        w.dirty.add(d.slice(0, 7));
        detailed++;
      }
      await saveMonths(w);
    } catch (e) {
      console.warn(`  ${w.st.id} (hodinová měření): ${e.message}`);
    }
  }
  if (detailed) console.log(`Hodinová měření doplněna k ${detailed} stanice-dnům.`);

  await writeJson(resolve(ARCHIVE, "_meta.json"), { collected: new Date().toISOString() });
  console.log(
    `Hotovo: nově ${added} stanice-dní, Open-Meteo ${Math.round(omSpent)} z ${OM_BUDGET}` +
      (skipped ? `, ${skipped} úseků odloženo na příští běh (rozpočet)` : "") + ".",
  );
  if (!added && !work.some((w) => w.chunks.length === 0)) {
    console.error("Žádná stanice nemá data.");
    process.exitCode = 1;
  }
}

await main();
