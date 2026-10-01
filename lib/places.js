// Našeptávač míst: Google Places API (New), když je nastavený klíč
// GOOGLE_MAPS_API_KEY; jinak zdarma Open-Meteo geokódování. Klíč zůstává
// na serveru – prohlížeč volá jen /api/places a /api/place.
const GOOGLE_AUTOCOMPLETE = "https://places.googleapis.com/v1/places:autocomplete";
const GOOGLE_PLACE = (id) => `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`;
const OM_GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";

const key = () => process.env.GOOGLE_MAPS_API_KEY || "";

export async function suggest(q, session, lang = "cs") {
  if (key()) {
    const res = await fetch(GOOGLE_AUTOCOMPLETE, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key() },
      body: JSON.stringify({
        input: q,
        languageCode: lang,
        ...(session ? { sessionToken: session } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Google Places ${res.status}`);
    const data = await res.json();
    return {
      provider: "google",
      items: (data.suggestions ?? [])
        .map((s) => s.placePrediction)
        .filter(Boolean)
        .map((p) => ({
          id: p.placeId,
          label: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
          sub: p.structuredFormat?.secondaryText?.text ?? "",
        })),
    };
  }
  const p = new URLSearchParams({ name: q, count: "8", language: lang, format: "json" });
  const res = await fetch(`${OM_GEOCODE}?${p}`);
  if (!res.ok) throw new Error(`Open-Meteo geocoding ${res.status}`);
  const data = await res.json();
  return {
    provider: "open-meteo",
    items: (data.results ?? []).map((r) => ({
      id: `om:${r.id}`,
      label: r.name,
      sub: [r.admin1, r.country].filter(Boolean).join(", "),
      lat: r.latitude,
      lon: r.longitude,
    })),
  };
}

export async function details(id, session, lang = "cs") {
  if (!key()) throw new Error("Bez klíče Google nejsou detaily potřeba.");
  const p = new URLSearchParams({ languageCode: lang });
  if (session) p.set("sessionToken", session);
  const res = await fetch(`${GOOGLE_PLACE(id)}?${p}`, {
    headers: {
      "X-Goog-Api-Key": key(),
      "X-Goog-FieldMask": "id,displayName,formattedAddress,location",
    },
  });
  if (!res.ok) throw new Error(`Google Places ${res.status}`);
  const d = await res.json();
  return {
    id: d.id,
    label: d.displayName?.text ?? d.formattedAddress ?? "",
    sub: d.formattedAddress ?? "",
    lat: d.location?.latitude,
    lon: d.location?.longitude,
  };
}
