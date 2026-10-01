import { guard, query, send } from "../lib/http.js";
import { details } from "../lib/places.js";

// GET /api/place?id=<Google place id>&session=<uuid>  → souřadnice místa
export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const p = query(req);
  const id = p.get("id") ?? "";
  if (!/^[A-Za-z0-9_-]{4,300}$/.test(id)) return send(res, 400, { error: "Neplatné id místa." });
  try {
    send(res, 200, await details(id, p.get("session") ?? "", p.get("lang") ?? "cs"), { cacheSeconds: 86400 });
  } catch (e) {
    send(res, 502, { error: "Detail místa se nepodařilo načíst.", detail: String(e?.message ?? e) });
  }
}
