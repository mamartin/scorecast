// Noční sběr: pro každou stanici a každý den porovná archivní předpovědi
// (Open-Meteo Previous Runs API) s měřením (METAR přes Iowa Environmental
// Mesonet) a uloží denní souhrny chyb po modelech a předstizích.
//
//   node scripts/collect.mjs              doplní chybějící dny za poslední 3 dny
//   BACKFILL_DAYS=60 node scripts/collect.mjs   první naplnění historie
//
// Výstup:
//   archive/<stanice>.json        celá historie denních souhrnů (k přepočtům)
//   public/data/stations/<id>.json  posledních PUBLIC_DAYS dní (čte API)
//   public/data/stations.json     seznam stanic
//   public/data/meta.json         kdy a za jaké období se počítalo
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  F, F_LEN, LEADS, MODELS, TEMP_OK, VARIABLES, WET_MM, WIND_OK,
} from "../public/lib/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// OUT_DIR jen pro testy (aby testovací data nepřepsala skutečná).
const OUT = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : root;
const ARCHIVE = resolve(OUT, "archive");
const PUBLIC = resolve(OUT, "public/data");

const NETWORKS = (process.env.NETWORKS ?? "CZ__ASOS,SK__ASOS,AT__ASOS,DE__ASOS,PL__ASOS").split(",");
// Oblast ČR + okolí (pokrytí ALADIN a sousední regionální modely).
const BBOX = { minLat: 47.6, maxLat: 51.9, minLon: 11.0, maxLon: 19.9 };
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS ?? 3);
const PUBLIC_DAYS = 120;
const STATION_LIMIT = Number(process.env.STATION_LIMIT ?? 0); // jen pro testy
// Den musí mít aspoň tolik hodin měření, jinak ho přeskočíme (výpadek stanice).
const MIN_OBS_HOURS = 12;

const IEM_GEOJSON = (n) => `https://mesonet.agron.iastate.edu/geojson/network/${n}.geojson`;
const IEM_ASOS = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
const PREVIOUS_RUNS = "https://previous-runs-api.open-meteo.com/v1/forecast";
const HEADERS = { "User-Agent": "presnost-modelu/1.0 (overeni predpovedi pocasi)" };
const KNOT = 0.514444;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const hourKey = (t) => new Date(t).toISOString().slice(0, 13);

async function fetchText(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.text();
      last = new Error(`HTTP ${res.status} ${url.slice(0, 120)}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      last = e;
    }
    await sleep(2000 * (i + 1));
  }
  throw last;
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

// ---------- stanice ----------

async function loadStations() {
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
      });
    }
  }
  return STATION_LIMIT ? out.slice(0, STATION_LIMIT) : out;
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

// Vrací mapu hodina (UTC, "YYYY-MM-DDTHH") → { t, w, wet }.
// Teplota a vítr ze zprávy nejbližší celé hodině (±10 min); srážky = zda
// některá zpráva v předchozí hodině (H-60, H] hlásila padající srážky –
// stejně jako Open-Meteo počítá srážky za předchozí hodinu.
async function loadObservations(station, fromMs, toMs) {
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
  const hours = new Map();
  const slot = (k) => {
    let h = hours.get(k);
    if (!h) hours.set(k, (h = { t: null, tD: Infinity, w: null, wD: Infinity, reports: 0, wet: false }));
    return h;
  };
  if (iValid < 0) return hours;

  for (const line of lines) {
    const c = line.split(",");
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(c[iValid] ?? "");
    if (!m) continue;
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`);

    // Srážky: zpráva v (H-60, H] patří k hodině H.
    const ownHour = Math.ceil(t / 3_600_000) * 3_600_000;
    const ps = slot(hourKey(ownHour));
    ps.reports++;
    if (iWx >= 0 && isPrecip(c[iWx])) ps.wet = true;

    // Teplota a vítr: nejbližší celá hodina, max. 10 minut vedle.
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
  return hours;
}

// ---------- předpovědi ----------

const FORECAST_VARS = Object.values(VARIABLES).flatMap((v) =>
  LEADS.map((d) => `${v.om}_previous_day${d}`),
);

// Jeden dotaz na všechny modely; když ho Open-Meteo odmítne (některý model
// tu nemá data), zkusí modely po jednom. Vrací { times, get(model, var) }.
async function loadForecasts(station, startDay, endDay) {
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

function scoreDays(obs, fc) {
  const days = {}; // den → model → předstih → pole F
  const obsHoursPerDay = new Map();
  for (const [k, o] of obs) {
    if (o.t != null) obsHoursPerDay.set(k.slice(0, 10), (obsHoursPerDay.get(k.slice(0, 10)) ?? 0) + 1);
  }
  const vT = VARIABLES.temperature.om;
  const vW = VARIABLES.wind.om;
  const vP = VARIABLES.precipitation.om;

  fc.times.forEach((time, i) => {
    const key = String(time).slice(0, 13);
    const day = key.slice(0, 10);
    if ((obsHoursPerDay.get(day) ?? 0) < MIN_OBS_HOURS) return;
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
      }
    }
  });

  // Zaokrouhlit součty (úspora místa) a vyhodit prázdné záznamy.
  for (const byModel of Object.values(days)) {
    for (const [model, byLead] of Object.entries(byModel)) {
      for (const [d, a] of Object.entries(byLead)) {
        if (!a.some((x) => x)) delete byLead[d];
        else for (const j of [F.tAbs, F.tSum, F.wAbs, F.wSum]) a[j] = Math.round(a[j] * 10) / 10;
      }
      if (!Object.keys(byLead).length) delete byModel[model];
    }
  }
  return days;
}

// Souvislé úseky chybějících dní → méně dotazů.
function missingRanges(have, fromMs, toMs) {
  const ranges = [];
  let cur = null;
  for (let t = fromMs; t <= toMs; t += DAY) {
    const d = ymd(t);
    if (have[d]) {
      cur = null;
      continue;
    }
    if (cur && cur.end === t - DAY) cur.end = t;
    else ranges.push((cur = { start: t, end: t }));
  }
  return ranges;
}

async function main() {
  const stations = await loadStations();
  const today = Date.parse(ymd(Date.now()));
  const last = today - DAY; // včerejšek – poslední den s kompletním měřením
  const first = last - (BACKFILL_DAYS - 1) * DAY;
  console.log(`Stanic: ${stations.length}, dny ${ymd(first)} – ${ymd(last)}`);

  const index = [];
  let added = 0;
  for (const st of stations) {
    const path = resolve(ARCHIVE, `${st.id}.json`);
    const arch = await readJson(path, { days: {} });
    const ranges = missingRanges(arch.days, first, last);
    for (const r of ranges) {
      try {
        // Měření i z předchozího dne (srážky v hodině 00 UTC potřebují 23:xx).
        const obs = await loadObservations(st, r.start - DAY, r.end + DAY);
        const fc = await loadForecasts(st, ymd(r.start), ymd(r.end));
        const days = scoreDays(obs, fc);
        for (const [d, v] of Object.entries(days)) {
          if (Date.parse(d) >= r.start && Date.parse(d) <= r.end) {
            arch.days[d] = v;
            added++;
          }
        }
        console.log(`  ${st.id} ${st.name}: ${ymd(r.start)}–${ymd(r.end)} → ${Object.keys(days).length} dní`);
      } catch (e) {
        console.warn(`  ${st.id}: ${e.message}`);
      }
      await sleep(400); // šetrně k bezplatným API
    }

    const dayKeys = Object.keys(arch.days).sort();
    if (!dayKeys.length) continue;
    const sorted = Object.fromEntries(dayKeys.map((d) => [d, arch.days[d]]));
    await writeJson(path, { ...st, days: sorted });

    const cutoff = ymd(last - (PUBLIC_DAYS - 1) * DAY);
    const recent = Object.fromEntries(dayKeys.filter((d) => d >= cutoff).map((d) => [d, arch.days[d]]));
    await writeJson(resolve(PUBLIC, "stations", `${st.id}.json`), { ...st, days: recent });
    index.push({ ...st, firstDay: dayKeys[0], lastDay: dayKeys.at(-1) });
  }

  // Stanice, které dnes nepřišly (výpadek seznamu), ze seznamu nevyhazujeme.
  const previous = await readJson(resolve(PUBLIC, "stations.json"), []);
  for (const s of previous) if (!index.some((x) => x.id === s.id)) index.push(s);

  if (!index.length) {
    console.error("Žádná stanice nemá data – nic neukládám.");
    process.exitCode = 1;
    return;
  }
  await writeJson(resolve(PUBLIC, "stations.json"), index);
  await writeJson(resolve(PUBLIC, "meta.json"), {
    generated: new Date().toISOString(),
    lastDay: index.map((s) => s.lastDay).sort().at(-1),
    leads: LEADS,
    stations: index.length,
  });
  console.log(`Hotovo: ${index.length} stanic, nově ${added} stanice-dní.`);
}

await main();
