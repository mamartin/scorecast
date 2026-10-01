# Scorecast

Každou noc porovná, co jednotlivé modely předpovědi počasí předpověděly, s tím,
co stanice opravdu naměřily. Výsledek nabízí jako **webové srovnání pro libovolné
místo** a jako **API**, ze kterého si aplikace (například
[zmoknu](https://github.com/jvaclavik/zmoknu)) vezme nejlepší model pro místo.

Bez závislostí: Node 20+, statický web a serverless funkce na Vercelu.

## Jak to funguje

1. **Noční sběr** (`scripts/collect.mjs`, GitHub Action
   `.github/workflows/collect.yml`) stáhne měření a archivní předpovědi všech
   modelů vydané 1, 2, 3 a 5 dní předem
   ([Open-Meteo Previous Runs API](https://open-meteo.com/en/docs/previous-runs-api)):
   - **ČHMÚ** ([otevřená data](https://opendata.chmi.cz/)): asi 300 stanic
     v Česku s teplotou ve 2 m, z nich ~200 s větrem v 10 m a většina se
     srážkoměrem (úhrn v mm). Poslední 2–3 dny jsou v denních souborech
     (`now/`), starší v měsíčních (`recent/`), které ČHMÚ zveřejňuje začátkem
     dalšího měsíce – sběr je doplní sám, jakmile vyjdou.
   - **METAR** letišť v Česku a okolních státech přes
     [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/).

   Pro teplotu, vítr a srážky spočítá denní souhrny chyb a uloží je do
   `archive/<stanice>/<RRRR-MM>.json` (`empty` = dny, kdy stanice neměřila,
   aby se na ně sběr neptal znovu). Dotazy na Open-Meteo brzdí podle limitů
   zdarma (600 za minutu, 5 000 za hodinu) a hlídá rozpočet na běh
   (`OM_BUDGET`); nejdřív plní nejnovější dny, zbytek doplní další noc.
   Commit spustí nový deploy na Vercelu.
2. **Příprava dat** (`scripts/build-data.mjs`, běží při nasazení): z archivu
   spočítá součty za okna 7, 30 a 90 dní a posledních 14 dní po dnech
   (`public/data/`, není v gitu – jinak by se každou noc přepisovaly desítky MB).
3. **API** vybere stanice v okolí místa: nejbližší v podobné nadmořské výšce
   (rozdíl 100 m = 5 km navíc), obvykle do 25 km, jinak dál do 80 km, aspoň 3.
   Stanice musí mít data aspoň ve 40 % dní okna; stanice ČHMÚ a METAR na
   jednom místě se počítají jednou. Sečte je (bližší váží víc) a spočítá
   metriky a hodnocení. Výšku místa zjistí z Open-Meteo, pokud ji nepošlete.
4. **Web** (`public/`) – vyhledání místa, doporučený model, pořadí modelů,
   statistiky pro teplotu, vítr a srážky a hodnocení den po dni.

### Metriky

| Veličina | Co měříme |
|---|---|
| Teplota | průměrná odchylka (°C), systematický posun, podíl hodin do ±2 °C |
| Vítr | průměrná odchylka (m/s), podíl hodin do ±2 m/s |
| Srážky | trefa deště: trefené deštivé hodiny / (trefené + nepředpovězené + plané poplachy) |

**Hodnocení 0–100** = jak blízko má model k nejlepšímu (100 = nejlepší).
Teplota váží 50 %, vítr a srážky po 25 % (`public/lib/config.js`).

## API

Všechna volání jsou `GET`, vrací JSON a povolují CORS.

### `/api/best?lat=50.08&lon=14.42` – pro aplikaci

```json
{
  "model": "chmi_aladin_cz_1km", "label": "ČHMÚ ALADIN", "score": 95,
  "mae": 0.54, "baselineMae": 0.65,
  "station": "Praha, Karlov", "distanceKm": 2, "stations": 3,
  "leads": [1, 2], "window": { "start": "2026-09-01", "end": "2026-09-30", "days": 30 },
  "bestBy": { "temperature": "chmi_aladin_cz_1km", "wind": "ecmwf_ifs025", "precipitation": "icon_seamless" },
  "mix": {
    "temperature": { "model": "best_match", "label": "Automaticky", "metric": "mae", "value": 0.94, "auto": 0.94, "gainPct": 0 },
    "wind": { "model": "gfs_seamless", "label": "NOAA GFS", "metric": "mae", "value": 0.96, "auto": 1.26, "gainPct": 24 },
    "precipitation": { "model": "best_match", "label": "Automaticky", "metric": "csi", "value": 31, "auto": 31, "gainPct": 0 }
  }
}
```

`mix` je model zvlášť pro teplotu, vítr a srážky, ze kterých aplikace skládá
předpověď. Automaticky (`best_match`) nahradí jen model s jasným náskokem
(`gainPct`, práh `MIX_MIN_GAIN` v `public/lib/config.js`: 5 % u teploty
a větru). Srážky zatím zůstávají Automaticky: podle ověření na datech jejich
výběr podle METAR nepomáhá.

Bez stanic v okolí vrací `"model": null` a `"mix": null` – aplikace pak použije
svůj výchozí model.

### `/api/compare?lat=…&lon=…&days=30&leads=1,2` – plné srovnání

`days` 7, 30 nebo 90 (jiná hodnota se zaokrouhlí na nejbližší), `leads` z 1, 2,
3, 5 (víc oddělit čárkou), volitelně `radius` (km, nejvzdálenější stanice)
a `elev` (nadmořská výška místa v m; bez ní ji API zjistí samo). Totéž platí
pro `/api/best`. Vrací stanice s vahou, vzdáleností a výškovým rozdílem,
modely seřazené podle hodnocení (metriky pro každou veličinu a hodnocení za
posledních 14 dní po dnech), doporučený model, nejlepší model pro každou
veličinu a mix.

### `/api/places?q=…` a `/api/place?id=…` – našeptávač míst

S proměnnou `GOOGLE_MAPS_API_KEY` používá Google Places API (New), bez ní zdarma
geokódování Open-Meteo. Klíč zůstává na serveru.

### `/api/meta` – čas posledního výpočtu a seznam stanic

## Spuštění

```bash
npm test          # sběr nad napodobenými API + kontrola API (bez sítě)
npm run collect   # doplní chybějící dny za posledních 35 dní (jako noční běh)
npm run backfill  # totéž za 90 dní
npm run dev       # připraví data z archivu a spustí http://localhost:3000
```

Sběr skutečných dat trvá kvůli limitům Open-Meteo kolem dvou hodin. Na
vyzkoušení stačí pár stanic: `SOURCES=chmi STATION_LIMIT=5 npm run collect`.

Lokální server nad testovacími daty:

```bash
OUT_DIR=/tmp/scorecast-test npm test
DATA_ROOT=/tmp/scorecast-test node --import ./test/mock-fetch.mjs scripts/dev-server.mjs
```

## Nasazení

1. Vytvořte repozitář na GitHubu a nahrajte projekt.
2. Na [vercel.com](https://vercel.com) **Add New → Project**, vyberte repozitář
   (build `node scripts/build-data.mjs` je ve `vercel.json`). Volitelně
   doplňte `GOOGLE_MAPS_API_KEY` v *Settings → Environment Variables*.
3. V GitHubu: *Actions → Noční ověření modelů → Run workflow*. Dál běží každou
   noc samo a postupně doplňuje historii.

### Google Places

V [Google Cloud Console](https://console.cloud.google.com/) zapněte **Places API (New)**,
vytvořte API klíč a omezte ho jen na toto API. Klíč volá server, ne prohlížeč,
takže omezení podle webové domény nepoužívejte. Našeptávač posílá
`sessionToken`, takže Google účtuje celé hledání jako jednu relaci.

## Omezení a další kroky

- Srážky se zatím hodnotí jen jako trefa/minutí (déšť ≥ 0,1 mm za hodinu),
  i když ČHMÚ měří úhrny. Další krok: chyba v mm a radarový odhad srážek ČHMÚ
  (MERGE, mřížka 1 km), aby šlo ověřovat i mimo stanice.
- Archiv roste zhruba o 340 MB ročně (~330 stanic, 2,8 kB na stanici a den). Na rok dva to v gitu
  stačí, pak bude lepší ho přesunout do úložiště mimo repozitář.
- V okolních státech zůstávají jen letiště (METAR).
- Open-Meteo je zdarma pro nekomerční použití. Při komerčním provozu je
  potřeba jejich placený plán.
