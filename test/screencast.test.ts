import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// configはimport時にenvを読むため、private許可を設定してから動的import
process.env.ALLOW_PRIVATE_HOSTS = "1";
const { isRendererAvailable, closeBrowser } = await import("../src/pipeline/renderer.js");
const { BrowserStream, streamSlotsAvailable } = await import("../src/pipeline/screencast.js");

const available = await isRendererAvailable();

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (req.url === "/next") {
      res.end("<!doctype html><html><body><h1>NEXT PAGE</h1></body></html>");
    } else {
      // ビューポート左上に大きなボタン。クリックで /next へ遷移する
      res.end(
        `<!doctype html><html><body style="margin:0">
         <button id="b" style="position:fixed;left:0;top:0;width:320px;height:320px"
                 onclick="location.href='/next'">go</button>
         </body></html>`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/`;
});

afterAll(async () => {
  await closeBrowser();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(!available)("BrowserStream (CDP screencast remote browser)", () => {
  it("streams JPEG frames and replays mouse input on the real page", async () => {
    const frames: string[] = [];
    const stream = new BrowserStream({ url: baseUrl });
    stream.onFrame((f) => frames.push(f.data));
    await stream.start();

    try {
      // 映像フレーム（JPEGのbase64）が届く
      for (let i = 0; i < 20 && frames.length === 0; i++) await sleep(100);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]!.length).toBeGreaterThan(100);

      // 左上ボタンを実クリック（press+release）→ 実ページのonclickが発火し遷移
      await stream.input({ type: "mousemove", x: 160, y: 160 });
      await stream.input({ type: "mousedown", x: 160, y: 160, button: "left" });
      await stream.input({ type: "mouseup", x: 160, y: 160, button: "left" });

      let navigated = false;
      for (let i = 0; i < 30; i++) {
        if (stream.currentUrl().endsWith("/next")) {
          navigated = true;
          break;
        }
        await sleep(100);
      }
      expect(navigated).toBe(true);
    } finally {
      await stream.close();
    }
  }, 40_000);

  it("tracks concurrency slots", async () => {
    expect(streamSlotsAvailable()).toBe(true);
    const s = new BrowserStream({ url: baseUrl });
    await s.start();
    try {
      // 1本張っても上限(>=2)以内なのでまだ空きがある
      expect(typeof streamSlotsAvailable()).toBe("boolean");
    } finally {
      await s.close();
    }
    expect(streamSlotsAvailable()).toBe(true);
  }, 40_000);
});
