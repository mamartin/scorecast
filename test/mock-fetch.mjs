// Napodobené odpovědi IEM a Open-Meteo (ve tvaru jejich API) pro offline test.
// Každý model má jinou přesnost pro teplotu, vítr a srážky, krátkodobé
// regionální modely nemají data pro delší předstih ani mimo svou oblast.
const STATIONS = {
  CZ__ASOS: [["LKPR", "Prague", 14.2578, 50.1008, 365], ["LKTB", "Brno", 16.6889, 49.1531, 246],
    ["LKMT", "Ostrava", 18.1208, 49.6975, 256], ["LKKV", "Karlovy Vary", 12.9098, 50.202, 604],
    ["LKPD", "Pardubice", 15.7406, 50.0161, 226], ["LKLB", "LIBEREC", 15.025, 50.7683, 405]],
  DE__ASOS: [["EDDM", "Munich", 11.786, 48.354, 453], ["EDDC", "Dresden", 13.767, 51.134, 230], ["EDDH", "Hamburg", 9.99, 53.63, 16]],
  AT__ASOS: [["LOWW", "Vienna", 16.57, 48.11, 183], ["LOWL", "Linz", 14.19, 48.23, 298]],
  PL__ASOS: [["EPKT", "Katowice", 19.08, 50.47, 303]],
  SK__ASOS: [["LZIB", "Bratislava", 17.21, 48.17, 133]],
};
const ALL = Object.values(STATIONS).flat();
const pos = Object.fromEntries(ALL.map(([id, , lon, lat]) => [id, { lat, lon }]));

// Deterministický „náhodný" šum podle klíče.
function h(str) {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) x = Math.imul(x ^ str.charCodeAt(i), 16777619);
  return ((x >>> 0) % 100000) / 100000;
}
const noise = (k) => (h(k) + h(k + "b") + h(k + "c") - 1.5) * 1.15; // ~N(0,1)

const truthT = (st, t) => 8 + 7 * Math.sin((2 * Math.PI * (t / 3.6e6 - 9)) / 24) + 3 * Math.sin(t / 3.6e6 / 70) + noise(st + t);
const truthW = (st, t) => Math.max(0, 3.5 + 2 * Math.sin(t / 3.6e6 / 31) + noise(st + "w" + t));
const truthWet = (st, t) => Math.sin(t / 3.6e6 / 9 + h(st) * 6) > 0.72 || h(st + "r" + Math.floor(t / 3.6e6)) > 0.97;

// Přesnost modelů: [chyba teploty, chyba větru, trefa deště, plané poplachy, horizont dní, oblast]
const CZ = (lat, lon) => lat > 48.4 && lat < 51.2 && lon > 11.9 && lon < 19;
const SKILL = {
  best_match: [1.1, 1.2, 0.7, 0.05, 16], icon_seamless: [1.0, 1.25, 0.75, 0.05, 7],
  gfs_seamless: [1.8, 1.5, 0.55, 0.08, 16], meteofrance_seamless: [1.3, 1.3, 0.6, 0.06, 4],
  ecmwf_ifs025: [1.2, 0.95, 0.65, 0.05, 15], ukmo_seamless: [1.35, 1.1, 0.6, 0.06, 7],
  kma_seamless: [1.9, 1.6, 0.5, 0.08, 12], jma_seamless: [2.1, 1.7, 0.45, 0.07, 11],
  meteoswiss_icon_seamless: [1.15, 1.3, 0.7, 0.06, 5, (la, lo) => lo < 13.5 && la < 49],
  metno_seamless: [1.3, 1.3, 0.6, 0.06, 2.5, (la) => la > 50.5], gem_seamless: [1.7, 1.5, 0.5, 0.07, 10],
  bom_access_global: [2.2, 1.8, 0.45, 0.08, 10], cma_grapes_global: [2.3, 1.9, 0.4, 0.09, 10],
  knmi_seamless: [1.25, 1.2, 0.62, 0.05, 2.5, (la) => la > 51], dmi_seamless: [1.3, 1.2, 0.6, 0.05, 2.5, (la) => la > 51],
  italia_meteo_arpae_icon_2i: [1.4, 1.4, 0.55, 0.06, 3, (la) => la < 48.6],
  geosphere_seamless: [1.05, 1.2, 0.68, 0.05, 2.5, (la, lo) => la < 49.2 && lo > 12],
  chmi_aladin_cz_1km: [0.85, 1.15, 0.72, 0.06, 3, CZ],
};

const ok = (body) => new Response(body, { status: 200 });
globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (u.pathname.includes("/geojson/network/")) {
    const net = u.pathname.split("/").pop().replace(".geojson", "");
    const features = (STATIONS[net] ?? []).map(([sid, sname, lon, lat, elevation]) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { sid, sname, elevation },
    }));
    return ok(JSON.stringify({ type: "FeatureCollection", features }));
  }
  if (u.pathname.endsWith("asos.py")) {
    const sp = u.searchParams;
    const st = sp.get("station");
    const s = Date.UTC(+sp.get("year1"), +sp.get("month1") - 1, +sp.get("day1"));
    const e = Date.UTC(+sp.get("year2"), +sp.get("month2") - 1, +sp.get("day2")) + 86400000;
    let out = "station,valid,tmpc,sknt,wxcodes\n";
    for (let t = s; t < e; t += 1800000) {
      if (h(st + "gap" + t) < 0.03) continue; // občas chybí zpráva
      const d = new Date(t).toISOString();
      const hour = Math.ceil(t / 3.6e6) * 3.6e6;
      const wx = truthWet(st, hour) ? "-RA" : h(st + "br" + t) > 0.9 ? "BR" : "M";
      out += `${st},${d.slice(0, 10)} ${d.slice(11, 16)},${Math.round(truthT(st, hour))},${Math.round(truthW(st, hour) / 0.514444)},${wx}\n`;
    }
    return ok(out);
  }
  if (u.hostname.startsWith("previous-runs-api")) {
    const sp = u.searchParams;
    const models = sp.get("models").split(",");
    const lat = +sp.get("latitude");
    const lon = +sp.get("longitude");
    const st = Object.keys(pos).find((k) => Math.abs(pos[k].lat - lat) < 1e-3 && Math.abs(pos[k].lon - lon) < 1e-3);
    const s = Date.parse(sp.get("start_date") + "T00:00Z");
    const e = Date.parse(sp.get("end_date") + "T00:00Z") + 86400000;
    const time = [];
    for (let t = s; t < e; t += 3.6e6) time.push(new Date(t).toISOString().slice(0, 16));
    const hourly = { time };
    for (const m of models) {
      const [eT, eW, pHit, pFa, horizon, area] = SKILL[m];
      for (const v of sp.get("hourly").split(",")) {
        const lead = +v.split("_previous_day")[1];
        const grow = 1 + 0.18 * (lead - 1);
        const inArea = !area || area(lat, lon);
        hourly[models.length === 1 ? v : `${v}_${m}`] = time.map((tt) => {
          if (!inArea || lead > horizon) return null;
          const t = Date.parse(tt + "Z");
          const k = `${m}${st}${v}${t}`;
          if (v.startsWith("temperature")) return +(truthT(st, t) + noise(k) * eT * grow + 0.3).toFixed(1);
          if (v.startsWith("wind")) return +Math.max(0, truthW(st, t) + noise(k) * eW * grow).toFixed(1);
          const wet = truthWet(st, t);
          const pred = wet ? h(k) < pHit / grow : h(k) < pFa * grow;
          return pred ? +(0.2 + h(k + "a") * 2).toFixed(1) : 0;
        });
      }
    }
    return ok(JSON.stringify({ hourly }));
  }
  if (u.hostname.startsWith("geocoding-api")) {
    return ok(JSON.stringify({ results: [{ id: 3067696, name: "Praha", latitude: 50.088, longitude: 14.421, country: "Česko", admin1: "Hlavní město Praha" }] }));
  }
  return new Response("nenalezeno", { status: 404 });
};
