// Offline test: sběr nad napodobenými API do dočasné složky, příprava dat
// pro API a volání API.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const out = process.env.OUT_DIR ?? mkdtempSync(join(tmpdir(), "scorecast-"));
const days = process.env.TEST_DAYS ?? "40";
const run = (script, env = {}) => {
  const r = spawnSync(process.execPath, ["--import", join(root, "test/mock-fetch.mjs"), join(root, script)], {
    // Limity Open-Meteo v testu nebrzdí (napodobené API).
    env: { ...process.env, OUT_DIR: out, BACKFILL_DAYS: days, OM_PER_MINUTE: "1e9", OM_PER_HOUR: "1e9", ...env },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
};
const collected = run("scripts/collect.mjs");
console.log(collected.split("\n").filter((l) => /^(Stanic|Hotovo)/.test(l)).join("\n"));
assert.ok(existsSync(join(out, "archive/H3LSNE01/station.json")), "chybí stanice ČHMÚ");
assert.ok(!existsSync(join(out, "archive/ZIS04030")), "stanice mimo ČR");
assert.ok(!existsSync(join(out, "archive/B1SRAZ01")), "stanice bez teploty");
assert.match(collected, /Radar MERGE: 6 hodinových snímků/);

// Úhrn srážek včera: srážkoměr (Libuš, 24 h), radar (letiště LKPR a Trutnov
// bez srážkoměru, jen 6 h se snímky).
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const pHours = (id) => {
  const mo = JSON.parse(readFileSync(join(out, `archive/${id}/${yesterday.slice(0, 7)}.json`), "utf8"));
  return mo.days[yesterday]?.best_match?.[1]?.[12] ?? 0;
};
assert.ok(pHours("P1PLIB01") >= 20, `Libuš: srážkoměr ${pHours("P1PLIB01")} h`);
assert.equal(pHours("LKPR"), 6, "LKPR: úhrn z radaru");
assert.equal(pHours("H1TRUT01"), 6, "Trutnov: úhrn z radaru");
assert.equal(pHours("EDDM"), 0, "Mnichov je mimo dosah radaru");

// Radar: rohy mřížky a filtr falešného echa.
const radar = await import(join(root, "scripts/radar.mjs"));
const grid = radar.decodeMerge(readFileSync(join(root, "test/fixtures/merge-202609241000.hdf")));
assert.equal(grid.length, 598 * 378);
assert.equal(radar.mergePixel(51.458, 19.6239), 597);
assert.equal(radar.mergePixel(45, 10), -1);
assert.ok(radar.mergeValue(grid, radar.mergePixel(50.736, 15.74)) > 5, "Sněžka 24. 9. pršelo");
const stuck = new Map(Array.from({ length: 14 }, (_, h) => [`2026-09-27T${String(h).padStart(2, "0")}`, h < 2 ? 0.5 : 0.2]));
radar.dropStuck(stuck);
assert.deepEqual([...stuck.keys()], ["2026-09-27T00", "2026-09-27T01"]);

// Druhý běh nemá co doplňovat (dny bez měření jsou označené jako prázdné).
assert.match(run("scripts/collect.mjs"), /nově 0 stanice-dní/);
console.log(run("scripts/build-data.mjs").trim());

process.chdir(out);
await import(join(root, "test/mock-fetch.mjs"));
const call = async (name, qs) => {
  const mod = await import(join(root, "api", `${name}.js`));
  let status = 0;
  let body = "";
  const res = { setHeader() {}, set statusCode(v) { status = v; }, get statusCode() { return status; }, end(b) { body = b ?? ""; } };
  await mod.default({ method: "GET", url: `/api/${name}?${qs}` }, res);
  return { status, json: body ? JSON.parse(body) : null };
};
const ids = (c) => c.json.stations.map((s) => s.id);

const c = await call("compare", "lat=50.08&lon=14.42&days=30");
assert.equal(c.status, 200);
assert.ok(c.json.models.length > 5, "málo modelů");
console.log("Praha – pořadí:", c.json.models.slice(0, 5).map((m) => `${m.id} ${m.score}`).join(", "));
console.log("Praha – stanice:", c.json.stations.map((s) => `${s.id} ${s.distanceKm}km ${s.elevDiff ?? "?"}m ${s.weightPct}%`).join(", "));
assert.equal(c.json.models[0].rank, 1);
assert.ok(c.json.models.every((m) => m.daily.length === 14));
assert.ok(!c.json.models.some((m) => m.id === "knmi_seamless"), "KNMI by v Praze neměl mít data");
assert.equal(c.json.stations[0].src, "chmi", "nejbližší má být stanice ČHMÚ");
assert.ok(!ids(c).includes("LKPR"), "letiště má být za ČHMÚ, ne METAR (a jen jednou)");
assert.ok(c.json.stations.every((s) => s.distanceKm <= 25), "v Praze stačí stanice do 25 km");

const snapped = await call("compare", "lat=50.08&lon=14.42&days=10");
assert.equal(snapped.json.window.days, 7);

// Výška: na hřebeni vyhrává horská stanice, v Peci (816 m) údolní stanice.
const ridge = await call("compare", "lat=50.73&lon=15.74");
assert.equal(ridge.json.location.elev, 1500);
assert.equal(ids(ridge)[0], "H3LSNE01");
const valley = await call("compare", "lat=50.69&lon=15.73&elev=500");
assert.deepEqual(ids(valley).slice(0, 2), ["H3LPEC01", "H1TRUT01"]);
console.log("Krkonoše:", ids(ridge).join(", "), "|", ids(valley).join(", "));

const l5 = await call("compare", "lat=50.08&lon=14.42&days=30&leads=5");
assert.ok(!l5.json.models.some((m) => m.id === "chmi_aladin_cz_1km"), "ALADIN nemá předstih 5 dní");
console.log("Předstih 5 dní – vítěz:", l5.json.recommended);

const b = await call("best", "lat=49.2&lon=16.6");
assert.equal(b.status, 200);
assert.ok(b.json.model);
console.log("Brno /api/best:", b.json.model, b.json.station, `${b.json.distanceKm} km`);

// Mix: model pro každou veličinu, jiný než Automaticky jen s náskokem nad prahem.
const { MIX_MIN_GAIN, MODEL_BY_ID } = await import(join(root, "public/lib/config.js"));
for (const v of ["temperature", "wind", "precipitation"]) {
  const g = b.json.mix?.[v];
  assert.ok(g && MODEL_BY_ID[g.model], `mix bez ${v}`);
  if (g.model !== "best_match") assert.ok(g.gainPct >= 100 * MIX_MIN_GAIN[v], `${v}: malý náskok ${g.gainPct} %`);
  else assert.equal(g.gainPct, 0);
}
console.log("Brno mix:", Object.entries(b.json.mix).map(([v, g]) => `${v} ${g.model} (${g.gainPct} %)`).join(", "));

const far = await call("best", "lat=38.7&lon=-9.1");
assert.equal(far.json.model, null);
assert.equal(far.json.mix, null);
const bad = await call("compare", "lat=abc&lon=1");
assert.equal(bad.status, 400);
const pl = await call("places", "q=Praha");
assert.equal(pl.json.provider, "open-meteo");
console.log(`OK – data v ${out}`);
