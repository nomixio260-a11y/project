import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as cheerio from "cheerio";

// configはimport時にenvを読むため、private許可を設定してから動的import
process.env.ALLOW_PRIVATE_HOSTS = "1";
const { isRendererAvailable, closeBrowser } = await import("../src/pipeline/renderer.js");
const {
  openLiveSession,
  interactLiveSession,
  closeAllSessions,
  SessionGoneError,
} = await import("../src/pipeline/liveSession.js");

// Chromium未導入時はスイート全体をスキップ
const available = await isRendererAvailable();

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  // JSでのみ状態が変わるページ（クリックでカウンタ増加、入力をエコー）
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><head><title>t</title></head><body>
       <div id="out">count: 0</div>
       <button id="inc">inc</button>
       <input id="box" type="text">
       <div id="echo">echo: </div>
       <script>
         var c = 0;
         document.getElementById('inc').onclick = function () {
           c++; document.getElementById('out').textContent = 'count: ' + c;
         };
         document.getElementById('box').addEventListener('input', function (e) {
           document.getElementById('echo').textContent = 'echo: ' + e.target.value;
         });
       </script>
       </body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/`;
});

afterAll(async () => {
  await closeAllSessions();
  await closeBrowser();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** スナップショットHTMLから指定IDの data-dsp-ref を取り出す */
function refOf(html: string, id: string): string {
  const $ = cheerio.load(html);
  const ref = $(`#${id}`).attr("data-dsp-ref");
  if (!ref) throw new Error(`ref not found for #${id}`);
  return ref;
}

describe.skipIf(!available)("live session (headless Chromium)", () => {
  it("replays clicks and input on a persistent page and returns optimized snapshots", async () => {
    const snap0 = await openLiveSession(baseUrl, {});
    expect(snap0.html).toContain("count: 0");
    expect(snap0.html).toContain('data-dsp-ref="'); // 全要素に採番されている

    // クリックを再現 → カウンタが増える（JS実行＝サーバー側の常駐ページで状態保持）
    const incRef = refOf(snap0.html, "inc");
    const snap1 = await interactLiveSession(snap0.sid, { type: "click", ref: incRef });
    expect(snap1.sid).toBe(snap0.sid);
    expect(snap1.html).toContain("count: 1");

    // 同じセッションで再度クリック → 状態が累積している
    const snap2 = await interactLiveSession(snap1.sid, {
      type: "click",
      ref: refOf(snap1.html, "inc"),
    });
    expect(snap2.html).toContain("count: 2");

    // 入力の再現 → input イベントが発火しエコーされる
    const snap3 = await interactLiveSession(snap2.sid, {
      type: "input",
      ref: refOf(snap2.html, "box"),
      value: "hello",
    });
    expect(snap3.html).toContain("echo: hello");
  }, 40_000);

  it("rejects unknown/expired session ids", async () => {
    await expect(
      interactLiveSession("ffffffffffffffffffffffffffffffff", { type: "scroll", dy: 100 }),
    ).rejects.toBeInstanceOf(SessionGoneError);
  });
});
