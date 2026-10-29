const http = require("http");
const fs = require("fs");
const path = require("path");
const { find_spots } = require("./api/tools");

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

const send = (res, status, type, body) => {
  res.writeHead(status, { "Content-Type": type + "; charset=utf-8" });
  res.end(body);
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/api/find_spots") {
      const area = url.searchParams.get("area");
      const raw = url.searchParams.get("indoor");
      const indoor = raw === "true" ? true : raw === "false" ? false : undefined;
      const result = find_spots({ area, indoor });
      return send(res, result.error ? 400 : 200, "application/json", JSON.stringify(result));
    }

    if (url.pathname === "/api/config") {
      return send(res, 200, "application/json", JSON.stringify({
        url: process.env.SUPABASE_URL || "",
        anonKey: process.env.SUPABASE_ANON_KEY || "",
      }));
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return send(res, 200, "text/html", fs.readFileSync(path.join(ROOT, "index.html"), "utf8"));
    }

    send(res, 404, "text/plain", "Not found");
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT}`));
