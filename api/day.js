import { dayDetail, parseDayQuery } from "../lib/aggregate.js";
import { guard, query, send } from "../lib/http.js";

// GET /api/day?lat=50.08&lon=14.42&day=2026-09-30&model=icon_seamless&lead=1
// Hodinu po hodině: co model předpovídal a co naměřila nejbližší stanice.
export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const q = parseDayQuery(query(req));
  if (q.error) return send(res, 400, { error: q.error });
  try {
    // Minulé dny se už nemění → dlouhá cache.
    send(res, 200, await dayDetail(q), { cacheSeconds: 7 * 86400 });
  } catch (e) {
    send(res, 503, { error: "Detail dne se nepodařilo načíst.", detail: String(e?.message ?? e) });
  }
}
