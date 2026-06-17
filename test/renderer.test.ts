import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// configはimport時にenvを読むため、private許可を設定してから動的import
process.env.ALLOW_PRIVATE_HOSTS = "1";
const { renderPage, isRendererAvailable, closeBrowser } = await import(
  "../src/pipeline/renderer.js"
);

// Chromium未導入時はスイート全体をスキップ（CIではplaywright install後に実行）
const available = await isRendererAvailable();

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  // JSで中身を注入するページ（描画前は空、描画後に "hydrated" が現れる）
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><title>t</title></head><body>
       <div id="root"></div>
       <script>document.getElementById('root').innerHTML='<h1 id="js">hydrated</h1>';</script>
       </body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/`;
});

afterAll(async () => {
  await closeBrowser();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe.skipIf(!available)("renderPage (headless Chromium)", () => {
  it("executes JS and serializes the hydrated DOM", async () => {
    const { html, finalUrl } = await renderPage(baseUrl, { maxBytes: 5 * 1024 * 1024 });
    expect(html).toContain("hydrated");
    expect(html).toContain('id="js"');
    expect(finalUrl).toContain("127.0.0.1");
  }, 30_000);
});
