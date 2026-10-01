# Scorecast

Každou noc porovná, co jednotlivé modely předpovědi počasí předpověděly, s tím,
co stanice opravdu naměřily. Výsledek nabízí jako **webové srovnání pro libovolné
místo** a jako **API**, ze kterého si aplikace (například
[zmoknu](https://github.com/jvaclavik/zmoknu)) vezme nejlepší model pro místo.

Bez závislostí: Node 20+, statický web a serverless funkce na Vercelu.

## Jak to funguje

1. **Noční sběr** (`scripts/collect.mjs`, GitHub Action
   `.github/workflows/collect.yml`): pro každou letištní stanici v ČR a okolí
   stáhne měření (METAR přes [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu/))
   a archivní předpovědi všech modelů vydané 1, 2, 3 a 5 dní předem
   ([Open-Meteo Previous Runs API](https://open-meteo.com/en/docs/previous-runs-api)).
   Pro teplotu, vítr a srážky spočítá denní souhrny chyb a uloží je:
   - `archive/<stanice>.json` – celá historie (k pozdějším přepočtům),
   - `public/data/stations/<stanice>.json` – posledních 120 dní (čte API),
   - `public/data/stations.json`, `public/data/meta.json` – seznam stanic a čas výpočtu.

   Commit spustí nový deploy na Vercelu.
2. **API** sečte stanice do 80 km od místa (bližší váží víc) za zvolené období
   a předstih a spočítá metriky a hodnocení.
3. **Web** (`public/`) – vyhledání místa, doporučený model, pořadí modelů,
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
  "station": "Prague", "distanceKm": 12, "stations": 2,
  "leads": [1, 2], "window": { "start": "2026-09-01", "end": "2026-09-30", "days": 30 },
  "bestBy": { "temperature": "chmi_aladin_cz_1km", "wind": "ecmwf_ifs025", "precipitation": "icon_seamless" }
}
```

Bez stanic v okolí vrací `"model": null` – aplikace pak použije svůj výchozí model.

### `/api/compare?lat=…&lon=…&days=30&leads=1,2` – plné srovnání

`days` 3–120, `leads` z 1, 2, 3, 5 (víc oddělit čárkou), volitelně `radius` (km).
Vrací stanice s vahou, modely seřazené podle hodnocení (metriky pro každou
veličinu a hodnocení den po dni), doporučený model a nejlepší model pro každou veličinu.

### `/api/places?q=…` a `/api/place?id=…` – našeptávač míst

S proměnnou `GOOGLE_MAPS_API_KEY` používá Google Places API (New), bez ní zdarma
geokódování Open-Meteo. Klíč zůstává na serveru.

### `/api/meta` – čas posledního výpočtu a seznam stanic

## Spuštění

```bash
npm test          # sběr nad napodobenými API + kontrola API (bez sítě)
npm run backfill  # naplní posledních 60 dní skutečnými daty
npm run dev       # http://localhost:3000
```

`npm run collect` doplní jen chybějící dny za poslední 3 dny (to dělá noční běh).

Lokální server nad testovacími daty:

```bash
OUT_DIR=/tmp/scorecast-test npm test
DATA_ROOT=/tmp/scorecast-test node --import ./test/mock-fetch.mjs scripts/dev-server.mjs
```

## Nasazení

1. Vytvořte repozitář na GitHubu a nahrajte projekt.
2. Na [vercel.com](https://vercel.com) **Add New → Project**, vyberte repozitář
   (žádný build není potřeba). Volitelně doplňte `GOOGLE_MAPS_API_KEY`
   v *Settings → Environment Variables*.
3. V GitHubu: *Actions → Noční ověření modelů → Run workflow* s
   `backfill_days` = 60. Tím se naplní historie; dál běží každou noc samo.

### Google Places

V [Google Cloud Console](https://console.cloud.google.com/) zapněte **Places API (New)**,
vytvořte API klíč a omezte ho jen na toto API. Klíč volá server, ne prohlížeč,
takže omezení podle webové domény nepoužívejte. Našeptávač posílá
`sessionToken`, takže Google účtuje celé hledání jako jednu relaci.

## Omezení a další kroky

- Letištních stanic je v ČR jen 14 a většina leží v nížinách. Další krok:
  stanice ČHMÚ (open data), kterých je přes 200, včetně hor.
- METAR spolehlivě hlásí, *zda* prší, ne kolik. Pro úhrny srážek by bylo
  potřeba měření ČHMÚ nebo radarové odhady.
- Open-Meteo je zdarma pro nekomerční použití. Při komerčním provozu je
  potřeba jejich placený plán.
