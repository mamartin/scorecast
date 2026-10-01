import { guard, query, send } from "../lib/http.js";
import { suggest } from "../lib/places.js";

// GET /api/places?q=Sněžka&session=<uuid>  → návrhy míst
export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const p = query(req);
  const q = (p.get("q") ?? "").trim().slice(0, 100);
  if (q.length < 2) return send(res, 200, { items: [] });
  try {
    send(res, 200, await suggest(q, p.get("session") ?? "", p.get("lang") ?? "cs"), { cacheSeconds: 86400 });
  } catch (e) {
    send(res, 502, { error: "Hledání míst teď nefunguje.", detail: String(e?.message ?? e) });
  }
}
