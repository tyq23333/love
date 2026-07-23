import http from "http";

/** Railway 等平台会注入 PORT；本地未设置则跳过 */
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
    const path = req.url?.split("?")[0];
    if (path === "/" || path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // 必须绑 0.0.0.0，否则平台健康检查可能连不上
  server.listen(port, "0.0.0.0", () => {
    console.log(`[Health] 监听 0.0.0.0:${port}`);
  });
}
