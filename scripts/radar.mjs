// Radarový odhad srážek ČHMÚ MERGE (radar zkalibrovaný srážkoměry): hodinový
// úhrn v mřížce ~1 km nad Českem a okolím, nový snímek každých 10 minut,
// archiv zhruba týden. Soubor T_PASV23_C_OKPR_<RRRRMMDDHHmm>00.hdf (ODIM HDF5)
// obsahuje úhrn za hodinu končící časem v názvu – stejně jako hodinové srážky
// v Open-Meteo. Bereme snímky v celou hodinu.
import * as hdf5 from "jsfive";

export const MERGE_DIR = "https://opendata.chmi.cz/meteorology/weather/radar/composite/merge1h/hdf5/";
const W = 598;
const H = 378;
// Mercator (koule R = 6378137 m), levý horní roh mřížky a velikost pixelu
// (atributy `where` v souboru: UL_lon 11.266869, UL_lat 51.458369, scale 1555.7).
const R = 6378137;
const D2R = Math.PI / 180;
const X0 = R * 11.266869 * D2R;
const Y_TOP = R * Math.log(Math.tan(Math.PI / 4 + (51.458369 * D2R) / 2));
const SCALE = 1555.7;
const NODATA = 32767;
const UNDETECT = 32766;
const GAIN = 0.1;
// Stejná nenulová hodnota v pixelu tolik hodin po sobě = falešné echo (např.
// 27.–29. 9. 2026 stálo u Pardubic přes 30 h 0,1–0,5 mm), ne skutečný déšť.
const STUCK_HOURS = 12;

// Index pixelu pro souřadnice, nebo -1 mimo mřížku.
export function mergePixel(lat, lon) {
  const x = R * lon * D2R;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
  const col = Math.floor((x - X0) / SCALE);
  const row = Math.floor((Y_TOP - y) / SCALE);
  return col < 0 || col >= W || row < 0 || row >= H ? -1 : row * W + col;
}

// Surová mřížka z HDF5 → Uint16Array (W × H), nebo null.
export function decodeMerge(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dset = new hdf5.File(ab, "merge.hdf").get("dataset1/data1/data");
  if (!dset || dset.value.length !== W * H) return null;
  return Uint16Array.from(dset.value);
}

// Úhrn v mm pro pixel, nebo null (mimo dosah radaru).
export function mergeValue(grid, pixel) {
  if (pixel < 0) return null;
  const raw = grid[pixel];
  if (raw === NODATA) return null;
  return raw === UNDETECT ? 0 : raw * GAIN;
}

// Časy (ms, celé hodiny) snímků, které jsou teď k dispozici.
export async function mergeHours(fetchText) {
  const html = await fetchText(MERGE_DIR);
  const out = new Set();
  for (const m of html.matchAll(/T_PASV23_C_OKPR_(\d{4})(\d{2})(\d{2})(\d{2})0000\.hdf/g)) {
    out.add(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]));
  }
  return [...out].sort((a, b) => a - b);
}

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 12) + "00";

// Hodinové úhrny pro stanice: Map(id stanice → Map("RRRR-MM-DDTHH" → mm)).
// `fetchBuffer(url)` vrací Buffer nebo vyhodí chybu.
export async function loadMerge(stations, hours, fetchBuffer, { concurrency = 4 } = {}) {
  const pixels = stations.map((s) => [s.id, mergePixel(s.lat, s.lon)]).filter(([, p]) => p >= 0);
  const series = new Map(pixels.map(([id]) => [id, new Map()]));
  let next = 0;
  let loaded = 0;
  const worker = async () => {
    while (next < hours.length) {
      const t = hours[next++];
      let grid = null;
      try {
        grid = decodeMerge(await fetchBuffer(`${MERGE_DIR}T_PASV23_C_OKPR_${stamp(t)}.hdf`));
      } catch {
        /* snímek chybí nebo je poškozený – hodina zůstane bez radaru */
      }
      if (!grid) continue;
      loaded++;
      const key = new Date(t).toISOString().slice(0, 13);
      for (const [id, p] of pixels) {
        const v = mergeValue(grid, p);
        if (v != null) series.get(id).set(key, Math.round(v * 10) / 10);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  for (const s of series.values()) dropStuck(s);
  return { series, loaded };
}

// Vyhodí běhy stejné nenulové hodnoty delší než STUCK_HOURS (falešné echo).
export function dropStuck(byHour) {
  const keys = [...byHour.keys()].sort();
  let run = [];
  const flush = () => {
    if (run.length >= STUCK_HOURS) for (const k of run) byHour.delete(k);
    run = [];
  };
  for (const k of keys) {
    const v = byHour.get(k);
    const prev = run.length ? byHour.get(run.at(-1)) : null;
    const consecutive = run.length && Date.parse(k + ":00Z") - Date.parse(run.at(-1) + ":00Z") === 3_600_000;
    if (v > 0 && consecutive && v === prev) run.push(k);
    else {
      flush();
      if (v > 0) run = [k];
    }
  }
  flush();
}
