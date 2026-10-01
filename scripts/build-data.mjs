// Připraví data pro API z archivu (běží při nasazení na Vercelu a před
// lokálním serverem):
//   public/data/stations/<id>.json  součty za okna WINDOWS (7/30/90 dní)
//                                   a posledních DAILY_DAYS dní po dnech
//   public/data/stations.json       seznam stanic a kolik dní mají v každém okně
//   public/data/meta.json           kdy proběhl sběr a do kterého dne jsou data
// Archiv se commituje, public/data ne – jinak by se každou noc přepisovaly
// desítky MB v gitu.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DAILY_DAYS, F, F_LEN, LEADS, WINDOWS } from "../public/lib/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : root;
const ARCHIVE = resolve(OUT, "archive");
const PUBLIC = resolve(OUT, "public/data");
const DAY = 86_400_000;
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const MAX_WINDOW = Math.max(...WINDOWS);

const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = async (path, data) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data) + "\n");
};

const ids = (await readdir(ARCHIVE, { withFileTypes: true }).catch(() => []))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

// Měsíční soubory každé stanice; poslední den s daty napříč stanicemi určuje konec oken.
const stations = [];
let lastDay = "";
for (const id of ids) {
  const files = (await readdir(resolve(ARCHIVE, id))).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort();
  const meta = await readJson(resolve(ARCHIVE, id, "station.json"), null);
  if (!meta || !files.length) continue;
  const latest = await readJson(resolve(ARCHIVE, id, files.at(-1)), { days: {} });
  const own = Object.keys(latest.days).sort().at(-1);
  if (own && own > lastDay) lastDay = own;
  stations.push({ meta, files });
}

await rm(PUBLIC, { recursive: true, force: true });
if (!lastDay) {
  console.error("Archiv je prázdný – nic k přípravě.");
  process.exit(1);
}

const end = Date.parse(lastDay);
const from = ymd(end - (MAX_WINDOW - 1) * DAY);
const dailyFrom = ymd(end - (DAILY_DAYS - 1) * DAY);
const index = [];
for (const { meta, files } of stations) {
  const days = {};
  for (const f of files) {
    if (f.slice(0, 7) < from.slice(0, 7)) continue;
    const mo = await readJson(resolve(ARCHIVE, meta.id, f), { days: {} });
    for (const [d, v] of Object.entries(mo.days)) if (d >= from && d <= lastDay) days[d] = v;
  }
  const dayKeys = Object.keys(days).sort();
  if (!dayKeys.length) continue;

  const windows = {};
  const cover = {};
  for (const w of WINDOWS) {
    const start = ymd(end - (w - 1) * DAY);
    const sums = {}; // model → předstih → pole F
    let n = 0;
    for (const d of dayKeys) {
      if (d < start) continue;
      n++;
      for (const [model, byLead] of Object.entries(days[d])) {
        for (const [lead, a] of Object.entries(byLead)) {
          const s = ((sums[model] ??= {})[lead] ??= new Array(F_LEN).fill(0));
          for (let i = 0; i < F_LEN; i++) s[i] += a[i] ?? 0;
        }
      }
    }
    for (const byLead of Object.values(sums)) {
      for (const s of Object.values(byLead)) {
        for (const j of [F.tAbs, F.tSum, F.wAbs, F.wSum]) s[j] = Math.round(s[j] * 10) / 10;
      }
    }
    windows[w] = sums;
    cover[w] = n;
  }
  const daily = Object.fromEntries(dayKeys.filter((d) => d >= dailyFrom).map((d) => [d, days[d]]));
  const { id, name, lat, lon, elev, src } = meta;
  await writeJson(resolve(PUBLIC, "stations", `${id}.json`), { id, name, lat, lon, elev, src, windows, days: daily });
  index.push({ id, name, lat, lon, elev, src, firstDay: dayKeys[0], lastDay: dayKeys.at(-1), cover });
}

const collected = (await readJson(resolve(ARCHIVE, "_meta.json"), {})).collected ?? new Date().toISOString();
await writeJson(resolve(PUBLIC, "stations.json"), index);
await writeJson(resolve(PUBLIC, "meta.json"), {
  generated: collected,
  lastDay,
  leads: LEADS,
  windows: WINDOWS,
  stations: index.length,
});
const bySrc = index.reduce((a, s) => ({ ...a, [s.src]: (a[s.src] ?? 0) + 1 }), {});
console.log(`Data pro API: ${index.length} stanic ${JSON.stringify(bySrc)}, do ${lastDay}.`);
