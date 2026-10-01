import { compare, parseQuery } from "../lib/aggregate.js";
import { guard, query, send } from "../lib/http.js";

// GET /api/compare?lat=50.08&lon=14.42&days=30&leads=1,2
// Plné srovnání modelů pro místo (pro webové rozhraní).
export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const q = parseQuery(query(req));
  if (q.error) return send(res, 400, { error: q.error });
  try {
    send(res, 200, await compare(q), { cacheSeconds: 3600 });
  } catch (e) {
    send(res, 503, { error: "Data o přesnosti zatím nejsou k dispozici.", detail: String(e?.message ?? e) });
  }
}
