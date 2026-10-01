import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { guard, send } from "../lib/http.js";

// GET /api/meta → kdy proběhl poslední výpočet a seznam stanic (pro mapu/přehled).
export default async function handler(req, res) {
  if (!guard(req, res)) return;
  try {
    const dir = join(process.cwd(), "public", "data");
    const [meta, stations] = await Promise.all([
      readFile(join(dir, "meta.json"), "utf8").then(JSON.parse),
      readFile(join(dir, "stations.json"), "utf8").then(JSON.parse),
    ]);
    send(res, 200, { ...meta, stations }, { cacheSeconds: 3600 });
  } catch {
    send(res, 503, { error: "Data o přesnosti zatím nejsou k dispozici." });
  }
}
