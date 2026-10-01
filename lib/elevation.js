// Nadmořská výška místa (Open-Meteo, model terénu 90 m) pro výběr stanic
// v podobné výšce. Když se nepodaří zjistit, vrací null – stanice se pak
// vybírají jen podle vzdálenosti.
const ELEVATION = "https://api.open-meteo.com/v1/elevation";
const cache = new Map();

export function placeElevation(lat, lon) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (!cache.has(key)) {
    const job = fetch(`${ELEVATION}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`, {
      signal: AbortSignal.timeout(2000),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const e = Number(d?.elevation?.[0]);
        if (!Number.isFinite(e)) throw new Error("bez výšky");
        return Math.round(e);
      })
      .catch(() => {
        cache.delete(key); // příště zkusit znovu
        return null;
      });
    cache.set(key, job);
  }
  return cache.get(key);
}
