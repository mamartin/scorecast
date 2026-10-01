// Lokální server bez závislostí: statické soubory z public/ a funkce z api/.
// Spusť: node scripts/dev-server.mjs  → http://localhost:3000
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
// API čte data relativně k pracovnímu adresáři (jako na Vercelu); DATA_ROOT
// dovolí pustit server nad testovacími daty z npm test.
process.chdir(process.env.DATA_ROOT ?? root);
const PORT = Number(process.env.PORT ?? 3000);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5).replace(/[^a-z0-9-]/gi, "");
      const mod = await import(pathToFileURL(join(root, "api", `${name}.js`)).href);
      return await mod.default(req, res);
    }
    let path = normalize(join(root, "public", decodeURIComponent(url.pathname)));
    if (!path.startsWith(join(root, "public"))) throw new Error("forbidden");
    if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, "index.html");
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Nenalezeno");
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
