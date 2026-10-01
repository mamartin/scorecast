// Offline test: sběr nad napodobenými API do dočasné složky, pak volání API.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const out = process.env.OUT_DIR ?? mkdtempSync(join(tmpdir(), "presnost-"));
const days = process.env.TEST_DAYS ?? "40";
const r = spawnSync(process.execPath, ["--import", join(root, "test/mock-fetch.mjs"), join(root, "scripts/collect.mjs")], {
  env: { ...process.env, OUT_DIR: out, BACKFILL_DAYS: days },
  encoding: "utf8",
});
console.log(r.stdout.split("\n").slice(-3).join("\n"));
assert.equal(r.status, 0, r.stderr);

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

const c = await call("compare", "lat=50.08&lon=14.42&days=30");
assert.equal(c.status, 200);
assert.ok(c.json.models.length > 5, "málo modelů");
console.log("Praha – pořadí:", c.json.models.slice(0, 5).map((m) => `${m.id} ${m.score}`).join(", "));
console.log("Nejlepší podle veličin:", c.json.bestBy, "stanice:", c.json.stations.map((s) => `${s.id} ${s.distanceKm}km ${s.weightPct}%`).join(", "));
assert.equal(c.json.models[0].rank, 1);
assert.ok(c.json.models.every((m) => m.daily.length === 30));
assert.ok(!c.json.models.some((m) => m.id === "knmi_seamless"), "KNMI by v Praze neměl mít data");

const l5 = await call("compare", "lat=50.08&lon=14.42&days=30&leads=5");
assert.ok(!l5.json.models.some((m) => m.id === "chmi_aladin_cz_1km"), "ALADIN nemá předstih 5 dní");
console.log("Předstih 5 dní – vítěz:", l5.json.recommended);

const b = await call("best", "lat=49.2&lon=16.6");
assert.equal(b.status, 200);
assert.ok(b.json.model);
console.log("Brno /api/best:", b.json);

const far = await call("best", "lat=38.7&lon=-9.1");
assert.equal(far.json.model, null);
const bad = await call("compare", "lat=abc&lon=1");
assert.equal(bad.status, 400);
const pl = await call("places", "q=Praha");
assert.equal(pl.json.provider, "open-meteo");
console.log(`OK – data v ${out}`);
