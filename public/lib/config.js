// Sdílené nastavení – používá ho noční sběr, API i prohlížeč (čistý ES modul).

// Modely stejné jako v aplikaci zmoknu (id = název modelu v Open-Meteo).
export const MODELS = [
  { id: "best_match", label: "Automaticky", short: "Auto", color: "#5bb6ff" },
  { id: "icon_seamless", label: "DWD ICON", short: "ICON", color: "#e0a800" },
  { id: "gfs_seamless", label: "NOAA GFS", short: "GFS", color: "#2fa36b" },
  { id: "meteofrance_seamless", label: "Météo-France", short: "MF", color: "#e0608a" },
  { id: "ecmwf_ifs025", label: "ECMWF IFS", short: "ECMWF", color: "#8b6cf0" },
  { id: "ukmo_seamless", label: "UK Met Office", short: "UKMO", color: "#e07a2e" },
  { id: "kma_seamless", label: "KMA (Korea)", short: "KMA", color: "#1495b8" },
  { id: "jma_seamless", label: "JMA (Japonsko)", short: "JMA", color: "#d9414e" },
  { id: "meteoswiss_icon_seamless", label: "MeteoSwiss ICON-CH", short: "ICON-CH", color: "#b5174f" },
  { id: "metno_seamless", label: "MET Norway", short: "METNO", color: "#5a9fbf" },
  { id: "gem_seamless", label: "GEM (Kanada)", short: "GEM", color: "#3fa8c4" },
  { id: "bom_access_global", label: "BOM ACCESS-G", short: "BOM", color: "#7d4fd1" },
  { id: "cma_grapes_global", label: "CMA GRAPES", short: "CMA", color: "#c9822f" },
  { id: "knmi_seamless", label: "KNMI HARMONIE", short: "KNMI", color: "#6c9a46" },
  { id: "dmi_seamless", label: "DMI HARMONIE", short: "DMI", color: "#b39324" },
  { id: "italia_meteo_arpae_icon_2i", label: "ItaliaMeteo ARPAE", short: "ARPAE", color: "#24887c" },
  { id: "geosphere_seamless", label: "GeoSphere AROME", short: "GEO", color: "#d9706a" },
  { id: "chmi_aladin_cz_1km", label: "ČHMÚ ALADIN", short: "ČHMÚ", color: "#e8304f" },
];

export const MODEL_BY_ID = Object.fromEntries(MODELS.map((m) => [m.id, m]));

// S jakým předstihem hodnotíme (dny dopředu, viz *_previous_dayN v Open-Meteo).
export const LEADS = [1, 2, 3, 5];

// Veličiny: název v Open-Meteo a váha v celkovém hodnocení.
export const VARIABLES = {
  temperature: { om: "temperature_2m", label: "Teplota", unit: "°C", weight: 0.5 },
  wind: { om: "wind_speed_10m", label: "Vítr", unit: "m/s", weight: 0.25 },
  precipitation: { om: "precipitation", label: "Srážky", unit: "", weight: 0.25 },
};

// Mix pro aplikace (/api/best): pro každou veličinu nejlepší model, ale
// Automaticky nahradí jen s náskokem aspoň tolika (jinak by výběr skákal po
// šumu). Prahy z ověření na datech (výběr v srpnu, test v září 2026, 28 stanic,
// předstih 1–2 dny): u větru 5 % sníží chybu o 14 %, u teploty o 1–2 %.
// U srážek výběr na 1–2 dny nepomohl při žádném prahu (METAR hlásí jen, zda
// prší, ne kolik), proto je zatím vypnutý – zůstávají Automaticky.
export const AUTO_MODEL = "best_match";
export const MIX_MIN_GAIN = { temperature: 0.05, wind: 0.05, precipitation: Infinity };

// „Trefa": teplota do ±2 °C, vítr do ±2 m/s, déšť = aspoň 0,1 mm za hodinu.
export const TEMP_OK = 2;
export const WIND_OK = 2;
export const WET_MM = 0.1;

// Pořadí čísel v denním souhrnu (pole na model × předstih × den):
// teplota: počet, součet |chyb|, součet chyb, počet do ±2 °C
// vítr:    počet, součet |chyb|, součet chyb, počet do ±2 m/s
// srážky:  trefa, minutí, planý poplach, správně sucho
export const F = {
  tN: 0, tAbs: 1, tSum: 2, tOk: 3,
  wN: 4, wAbs: 5, wSum: 6, wOk: 7,
  hit: 8, miss: 9, fa: 10, cn: 11,
};
export const F_LEN = 12;
