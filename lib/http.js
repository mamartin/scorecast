// Pomocníci pro serverless funkce (běží na Vercelu i v lokálním dev serveru).
export function query(req) {
  return new URL(req.url ?? "/", "http://localhost").searchParams;
}

export function send(res, status, body, { cacheSeconds = 0 } = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // API volá i aplikace zmoknu z jiné domény.
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (cacheSeconds > 0) {
    res.setHeader("Cache-Control", `public, max-age=300, s-maxage=${cacheSeconds}, stale-while-revalidate=86400`);
  } else {
    res.setHeader("Cache-Control", "no-store");
  }
  res.end(JSON.stringify(body));
}

export function guard(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.end();
    return false;
  }
  if (req.method && req.method !== "GET") {
    send(res, 405, { error: "Jen GET." });
    return false;
  }
  return true;
}
