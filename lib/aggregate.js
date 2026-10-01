// Souhrn přesnosti modelů pro libovolné místo: najde stanice v okolí v podobné
// výšce, sečte jejich souhrny (vážené vzdáleností) a spočítá metriky a hodnocení.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AUTO_MODEL, DAILY_DAYS, F, F_LEN, LEADS, MIX_MIN_GAIN, MODEL_BY_ID, VARIABLES, WINDOWS,
} from "../public/lib/config.js";
import { placeElevation } from "./elevation.js";

const DATA = join(process.cwd(), "public", "data");
const DAY = 86_400_000;

export const DEFAULTS = { days: 30, leads: [1, 2], radiusKm: 80 };
export const LIMITS = { maxRadiusKm: 200 };

// Výběr stanic: výškový rozdíl se počítá jako vzdálenost navíc (100 m ≈ 5 km),
// protože stanice v jiné výšce (údolí, kopec) mívá jiné chyby modelů. Stačí
// stanice do NEAR_KM; jinak se hledá dál, dokud jich není MIN_STATIONS.
const KM_PER_M = 0.05;
const NEAR_KM = 25;
const MIN_STATIONS = 3;
const MAX_STATIONS = 8;
// Stanice musí mít data aspoň v takovém podílu dní okna.
const MIN_COVER = 0.4;
// Stanice blíž než tohle jsou jedno místo (např. letiště v síti ČHMÚ i METAR).
const SAME_SITE_KM = 3;

// Data se mění jen s novým deployem → cache na dobu života instance.
const cache = new Map();
async function readJson(name) {
  if (!cache.has(name)) {
    cache.set(
      name,
      readFile(join(DATA, name), "utf8").then(JSON.parse).catch((e) => {
        cache.delete(name);
        throw e;
      }),
    );
  }
  return cache.get(name);
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

function add(target, src, w) {
  for (let i = 0; i < F_LEN; i++) target[i] += (src[i] ?? 0) * w;
}

// Metriky z (vážených) součtů.
function metrics(a) {
  const tN = a[F.tN];
  const wN = a[F.wN];
  const wetEvents = a[F.hit] + a[F.miss] + a[F.fa];
  const total = wetEvents + a[F.cn];
  return {
    temperature: tN > 0
      ? { mae: a[F.tAbs] / tN, bias: a[F.tSum] / tN, okPct: (100 * a[F.tOk]) / tN }
      : null,
    wind: wN > 0
      ? { mae: a[F.wAbs] / wN, bias: a[F.wSum] / wN, okPct: (100 * a[F.wOk]) / wN }
      : null,
    precipitation: total > 0
      ? {
          csi: wetEvents > 0 ? (100 * a[F.hit]) / wetEvents : null,
          pod: a[F.hit] + a[F.miss] > 0 ? (100 * a[F.hit]) / (a[F.hit] + a[F.miss]) : null,
          far: a[F.hit] + a[F.fa] > 0 ? (100 * a[F.fa]) / (a[F.hit] + a[F.fa]) : null,
          pc: (100 * (a[F.hit] + a[F.cn])) / total,
          // Úhrn (jen kde ho známe ze srážkoměru nebo radaru).
          mae: a[F.pN] > 0 ? a[F.pAbs] / a[F.pN] : null,
          bias: a[F.pN] > 0 ? a[F.pSum] / a[F.pN] : null,
          heavyCsi: a[F.hit1] + a[F.miss1] + a[F.fa1] > 0
            ? (100 * a[F.hit1]) / (a[F.hit1] + a[F.miss1] + a[F.fa1])
            : null,
        }
      : null,
  };
}

// Hodnocení 0–100 vůči nejlepšímu modelu (100 = nejlepší ve všem).
// Teplota a vítr: nejmenší chyba / chyba modelu; srážky: trefa / nejlepší trefa.
function relativeScores(rows, { minT, minWetObs }) {
  const best = {
    temperature: Math.min(...rows.filter((r) => r.raw[F.tN] >= minT && r.m.temperature).map((r) => r.m.temperature.mae)),
    wind: Math.min(...rows.filter((r) => r.raw[F.wN] >= minT && r.m.wind).map((r) => r.m.wind.mae)),
    precipitation: Math.max(
      ...rows
        .filter((r) => r.raw[F.hit] + r.raw[F.miss] >= minWetObs && r.m.precipitation?.csi != null)
        .map((r) => r.m.precipitation.csi),
    ),
  };
  for (const r of rows) {
    const rel = {};
    if (r.raw[F.tN] >= minT && r.m.temperature && Number.isFinite(best.temperature)) {
      rel.temperature = r.m.temperature.mae > 0 ? (100 * best.temperature) / r.m.temperature.mae : 100;
    }
    if (r.raw[F.wN] >= minT && r.m.wind && Number.isFinite(best.wind)) {
      rel.wind = r.m.wind.mae > 0 ? (100 * best.wind) / r.m.wind.mae : 100;
    }
    if (
      r.raw[F.hit] + r.raw[F.miss] >= minWetObs &&
      r.m.precipitation?.csi != null &&
      best.precipitation > 0
    ) {
      rel.precipitation = (100 * r.m.precipitation.csi) / best.precipitation;
    }
    let sum = 0;
    let wsum = 0;
    for (const [v, x] of Object.entries(rel)) {
      sum += x * VARIABLES[v].weight;
      wsum += VARIABLES[v].weight;
    }
    r.rel = rel;
    r.score = wsum > 0 ? sum / wsum : null;
  }
}

// Pro každou veličinu nejlepší model; Automaticky ale nahradí jen s náskokem
// aspoň MIX_MIN_GAIN. Bere řádky s vypočteným `rel` (relativeScores).
function mixModels(rows) {
  const auto = rows.find((r) => r.id === AUTO_MODEL);
  const mix = {};
  for (const v of Object.keys(VARIABLES)) {
    const isCsi = v === "precipitation";
    const value = (r) => (isCsi ? r.m.precipitation.csi : r.m[v].mae);
    const top = rows.filter((r) => r.rel[v] != null).sort((a, b) => b.rel[v] - a.rel[v])[0];
    if (!top) continue;
    const a = auto?.rel[v] != null ? value(auto) : null;
    const t = value(top);
    let gain = null;
    if (a != null) {
      if (isCsi) gain = a > 0 ? (t - a) / a : t > 0 ? Infinity : 0;
      else gain = a > 0 ? (a - t) / a : 0;
    }
    // Automaticky bez dat nejde porovnat → vezmeme rovnou nejlepší.
    const pick = a == null || gain >= MIX_MIN_GAIN[v] ? top : auto;
    const round = isCsi ? Math.round : r2;
    mix[v] = {
      model: pick.id,
      label: MODEL_BY_ID[pick.id].label,
      metric: isCsi ? "csi" : "mae",
      value: round(value(pick)),
      auto: a == null ? null : round(a),
      gainPct: pick === auto ? 0 : gain == null ? null : Number.isFinite(gain) ? Math.round(100 * gain) : null,
    };
  }
  return mix;
}

export function parseQuery(params) {
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { error: "Chybí nebo je neplatné lat/lon." };
  }
  // Součty jsou předpočítané jen pro okna WINDOWS → nejbližší z nich.
  const want = Number(params.get("days") ?? DEFAULTS.days);
  const days = Number.isFinite(want)
    ? WINDOWS.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a))
    : DEFAULTS.days;
  const elev = params.has("elev") ? Number(params.get("elev")) : NaN;
  const leads = (params.get("leads") ?? DEFAULTS.leads.join(","))
    .split(",")
    .map(Number)
    .filter((d) => LEADS.includes(d));
  const radiusKm = Number(params.get("radius") ?? DEFAULTS.radiusKm);
  return {
    lat,
    lon,
    days,
    elev: Number.isFinite(elev) ? elev : null,
    leads: leads.length ? [...new Set(leads)].sort((a, b) => a - b) : DEFAULTS.leads,
    radiusKm: Number.isFinite(radiusKm) ? Math.min(LIMITS.maxRadiusKm, Math.max(10, radiusKm)) : DEFAULTS.radiusKm,
  };
}

// Stanice pro místo: nejbližší v podobné výšce, s dostatkem dat v okně.
function pickStations(index, { lat, lon, elev, days, radiusKm }) {
  const candidates = index
    .filter((s) => (s.cover?.[days] ?? 0) >= Math.ceil(MIN_COVER * days))
    .map((s) => {
      const d = distanceKm(lat, lon, s.lat, s.lon);
      const dh = elev != null && s.elev != null ? s.elev - elev : null;
      return { s, d, dh, eff: d + KM_PER_M * Math.abs(dh ?? 0) };
    })
    .filter((x) => x.eff <= radiusKm)
    .sort((a, b) => a.eff - b.eff);
  const picked = [];
  for (const x of candidates) {
    if (picked.length >= MAX_STATIONS || (x.eff > NEAR_KM && picked.length >= MIN_STATIONS)) break;
    const i = picked.findIndex((p) => distanceKm(p.s.lat, p.s.lon, x.s.lat, x.s.lon) < SAME_SITE_KM);
    if (i < 0) picked.push(x);
    // Na jednom místě má přednost ČHMÚ (měří i úhrn srážek) před METAR.
    else if (picked[i].s.src === "metar" && x.s.src === "chmi") picked[i] = x;
  }
  // Bližší stanice váží víc (inverzní čtverec, +5 km proti přehnané váze);
  // stanice s mezerami v měření méně.
  return picked.map((x) => ({ ...x, w: (x.s.cover[days] / days) / (x.eff + 5) ** 2 }));
}

export async function compare({ lat, lon, days, leads, radiusKm, elev = null }) {
  const [index, meta, placeElev] = await Promise.all([
    readJson("stations.json"),
    readJson("meta.json"),
    elev ?? placeElevation(lat, lon),
  ]);
  const endMs = Date.parse(meta.lastDay);
  const startMs = endMs - (days - 1) * DAY;
  const dayList = [];
  for (let t = endMs - (Math.min(DAILY_DAYS, days) - 1) * DAY; t <= endMs; t += DAY) dayList.push(ymd(t));

  const base = {
    location: { lat, lon, elev: placeElev },
    window: { start: ymd(startMs), end: meta.lastDay, days },
    leads,
    generated: meta.generated,
  };

  const weighted = pickStations(index, { lat, lon, elev: placeElev, days, radiusKm });
  if (!weighted.length) {
    return { ...base, stations: [], models: [], recommended: null, bestBy: {}, mix: null };
  }
  const totalW = weighted.reduce((a, x) => a + x.w, 0);

  const acc = new Map(); // model → { sum, raw, cover, daily: Map(day → {sum, raw}) }
  const model = (id) => {
    let m = acc.get(id);
    if (!m) acc.set(id, (m = { sum: new Array(F_LEN).fill(0), raw: new Array(F_LEN).fill(0), cover: 0, daily: new Map() }));
    return m;
  };
  for (const { s, w } of weighted) {
    const file = await readJson(`stations/${s.id}.json`);
    // Součty za celé okno jsou předpočítané (scripts/build-data.mjs).
    for (const [id, byLead] of Object.entries(file.windows?.[days] ?? {})) {
      const m = model(id);
      let any = false;
      for (const d of leads) {
        const a = byLead[d];
        if (!a) continue;
        add(m.sum, a, w);
        add(m.raw, a, 1);
        any = true;
      }
      if (any) m.cover += w;
    }
    // Den po dni jen za posledních DAILY_DAYS dní.
    for (const day of dayList) {
      for (const [id, byLead] of Object.entries(file.days?.[day] ?? {})) {
        const m = model(id);
        let dd = m.daily.get(day);
        if (!dd) m.daily.set(day, (dd = { sum: new Array(F_LEN).fill(0), raw: new Array(F_LEN).fill(0) }));
        for (const d of leads) {
          const a = byLead[d];
          if (!a) continue;
          add(dd.sum, a, w);
          add(dd.raw, a, 1);
        }
      }
    }
  }

  // Model musí mít data u stanic s aspoň polovinou celkové váhy, jinak sem
  // jen okrajově zasahuje a nejde ho férově porovnat.
  const rows = [...acc]
    .filter(([id, m]) => MODEL_BY_ID[id] && m.cover >= totalW * 0.5)
    .map(([id, m]) => ({ id, raw: m.raw, m: metrics(m.sum), daily: m.daily }));
  relativeScores(rows, { minT: Math.max(24, 6 * days), minWetObs: 5 });
  const mix = mixModels(rows);

  // Denní hodnocení (stejný princip, jen pro jeden den a mírnější minima).
  const dailyScore = new Map(rows.map((r) => [r.id, {}]));
  for (const day of dayList) {
    const dayRows = rows
      .filter((r) => r.daily.has(day))
      .map((r) => ({ id: r.id, raw: r.daily.get(day).raw, m: metrics(r.daily.get(day).sum) }));
    relativeScores(dayRows, { minT: 6, minWetObs: 2 });
    for (const r of dayRows) {
      dailyScore.get(r.id)[day] = {
        score: r.score == null ? null : Math.round(r.score),
        tempMae: r1(r.m.temperature?.mae),
      };
    }
  }

  const models = rows
    .filter((r) => r.score != null)
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({
      id: r.id,
      label: MODEL_BY_ID[r.id].label,
      color: MODEL_BY_ID[r.id].color,
      rank: i + 1,
      score: Math.round(r.score),
      rel: Object.fromEntries(Object.entries(r.rel).map(([k, v]) => [k, Math.round(v)])),
      temperature: r.m.temperature && {
        mae: r2(r.m.temperature.mae), bias: r2(r.m.temperature.bias), okPct: Math.round(r.m.temperature.okPct), n: r.raw[F.tN],
      },
      wind: r.m.wind && {
        mae: r2(r.m.wind.mae), bias: r2(r.m.wind.bias), okPct: Math.round(r.m.wind.okPct), n: r.raw[F.wN],
      },
      precipitation: r.m.precipitation && {
        csi: r.m.precipitation.csi == null ? null : Math.round(r.m.precipitation.csi),
        pod: r.m.precipitation.pod == null ? null : Math.round(r.m.precipitation.pod),
        far: r.m.precipitation.far == null ? null : Math.round(r.m.precipitation.far),
        pc: Math.round(r.m.precipitation.pc),
        wetHours: r.raw[F.hit] + r.raw[F.miss],
        mae: r.m.precipitation.mae == null ? null : Math.round(r.m.precipitation.mae * 1000) / 1000,
        bias: r.m.precipitation.bias == null ? null : Math.round(r.m.precipitation.bias * 1000) / 1000,
        mmHours: r.raw[F.pN],
        heavyCsi: r.m.precipitation.heavyCsi == null ? null : Math.round(r.m.precipitation.heavyCsi),
        heavyHours: r.raw[F.hit1] + r.raw[F.miss1],
      },
      daily: dayList.map((day) => ({ day, ...(dailyScore.get(r.id)[day] ?? { score: null, tempMae: null }) })),
    }));

  const bestBy = {};
  for (const v of Object.keys(VARIABLES)) {
    const top = models.filter((m) => m.rel[v] != null).sort((a, b) => b.rel[v] - a.rel[v])[0];
    if (top) bestBy[v] = top.id;
  }

  return {
    ...base,
    stations: weighted.map(({ s, d, dh, w }) => ({
      id: s.id, name: s.name, lat: s.lat, lon: s.lon, elev: s.elev, src: s.src,
      distanceKm: Math.round(d), elevDiff: dh == null ? null : Math.round(dh),
      days: s.cover[days], weightPct: Math.round((100 * w) / totalW),
    })),
    models,
    recommended: models[0] ? { id: models[0].id, label: models[0].label, score: models[0].score } : null,
    bestBy,
    mix,
  };
}

// Stručná odpověď pro aplikaci (zmoknu): který model použít.
export async function best(q) {
  const c = await compare(q);
  const top = c.models[0];
  if (!top) return { model: null, mix: null, stations: 0, leads: c.leads, window: c.window };
  const auto = c.models.find((m) => m.id === "best_match");
  return {
    model: top.id,
    label: top.label,
    score: top.score,
    mae: top.temperature?.mae ?? null,
    baselineMae: auto?.temperature?.mae ?? undefined,
    station: c.stations[0].name,
    distanceKm: c.stations[0].distanceKm,
    stations: c.stations.length,
    leads: c.leads,
    window: c.window,
    bestBy: c.bestBy,
    // Model zvlášť pro teplotu, vítr a srážky (Automaticky, pokud jiný nemá
    // jasný náskok) – aplikace z nich skládá předpověď.
    mix: c.mix,
  };
}
