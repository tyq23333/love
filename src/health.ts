import http from "http";

/** Railway 等平台需要监听 PORT；本地未设置则跳过 */
export function startHealthServer(): void {
  const raw = process.env["PORT"];
  if (!raw) return;

  const port = Number(raw);
  if (!Number.isFinite(port) || port <= 0) {
    console.warn(`[Health] 无效 PORT=${raw}，跳过健康检查服务`);
    return;
  }

  const body = JSON.stringify({ ok: true, service: "im-claude" });
  const server = http.createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    console.log(`[Health] 监听 :${port}`);
  });
}
