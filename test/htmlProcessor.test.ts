import { describe, it, expect } from "vitest";
import { processHtml } from "../src/pipeline/htmlProcessor.js";

const BASE = "https://example.com/";

describe("processHtml (normal mode)", () => {
  it("strips scripts and rewrites links/images", async () => {
    const input = `<!doctype html><html><head><title>t</title>
      <script>evil()</script></head>
      <body>
        <a href="/about">about</a>
        <img src="/pic.jpg">
        <video src="/v.mp4"></video>
      </body></html>`;
    const { html } = await processHtml(input, BASE, { text: false });

    expect(html).not.toContain("evil()");
    expect(html).not.toContain("<script");
    expect(html).toContain("/browse?url=https%3A%2F%2Fexample.com%2Fabout");
    expect(html).toContain("/img?url=https%3A%2F%2Fexample.com%2Fpic.jpg");
    expect(html).toContain("/video?url=https%3A%2F%2Fexample.com%2Fv.mp4");
  });

  it("removes blocked tracker hosts", async () => {
    const input = `<html><body>
      <img src="https://www.google-analytics.com/collect?v=1">
      <img src="/keep.png">
    </body></html>`;
    const { html } = await processHtml(input, BASE, { text: false });
    expect(html).not.toContain("google-analytics");
    expect(html).toContain("/img?url=https%3A%2F%2Fexample.com%2Fkeep.png");
  });

  it("removes inline event handlers", async () => {
    const input = `<html><body><div onclick="bad()">x</div></body></html>`;
    const { html } = await processHtml(input, BASE, { text: false });
    expect(html).not.toContain("onclick");
  });

  it("converts video embeds to click-to-play placeholders", async () => {
    const input = `<html><body>
      <iframe src="https://www.youtube.com/embed/abc123"></iframe>
    </body></html>`;
    const { html } = await processHtml(input, BASE, { text: false });
    expect(html).toContain("dsp-embed");
    expect(html).toContain("youtube.com/embed/abc123");
    expect(html).not.toContain("<iframe");
  });

  it("sizes images to the device width and collapses srcset", async () => {
    const input = `<html><body>
      <img src="/pic.jpg" srcset="/pic-1x.jpg 1x, /pic-2x.jpg 2x">
    </body></html>`;
    const { html } = await processHtml(input, BASE, { text: false, dw: 360, dpr: 1 });
    // 端末幅360px → /img の w=360 で要求
    expect(html).toContain("/img?url=https%3A%2F%2Fexample.com%2Fpic.jpg");
    expect(html).toContain("w=360");
    // 重複DLを避けるため srcset は除去
    expect(html).not.toContain("srcset");
    expect(html).not.toContain("pic-2x");
  });

  it("propagates device hints (dw/dpr) on navigation links", async () => {
    const input = `<html><body><a href="/next">n</a></body></html>`;
    const { html } = await processHtml(input, BASE, { text: false, dw: 412, dpr: 2 });
    expect(html).toContain("dw=412");
    expect(html).toContain("dpr=2");
  });

  it("injects utf-8 charset and CSP", async () => {
    const input = `<html><head><meta charset="shift_jis"></head><body>x</body></html>`;
    const { html } = await processHtml(input, BASE, { text: false });
    expect(html.toLowerCase()).toContain('charset="utf-8"');
    expect(html).toContain("Content-Security-Policy");
  });
});

describe("processHtml (text mode)", () => {
  it("removes images, video, iframe", async () => {
    const input = `<html><body>
      <img src="/a.jpg">
      <video src="/v.mp4"></video>
      <iframe src="https://youtube.com/embed/x"></iframe>
      <p>keep text</p>
    </body></html>`;
    const { html } = await processHtml(input, BASE, { text: true });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<video");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("dsp-embed");
    expect(html).toContain("keep text");
  });

  it("propagates text flag on links", async () => {
    const input = `<html><body><a href="/next">n</a></body></html>`;
    const { html } = await processHtml(input, BASE, { text: true });
    expect(html).toContain("text=1");
  });
});

describe("processHtml (Opera Mini相当の省データ最大モード)", () => {
  it("re-compresses images harder (small width + low quality) and propagates mini on links", async () => {
    const input = `<html><body><img src="/pic.jpg"><a href="/next">n</a></body></html>`;
    const { html } = await processHtml(input, BASE, { text: false, mini: true });
    // 画像は幅400・品質35で /img 経由に（強圧縮）
    expect(html).toContain("/img?url=https%3A%2F%2Fexample.com%2Fpic.jpg");
    expect(html).toMatch(/w=400/);
    expect(html).toMatch(/q=35/);
    // miniフラグはリンクへ伝播してモード維持
    expect(html).toContain("mini=1");
  });

  it("strips web fonts and background images to cut decorative traffic", async () => {
    const input = `<html><head>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto">
      <link rel="preload" as="font" href="/f.woff2">
      <style>@font-face{font-family:x;src:url(/x.woff2)} body{color:#000}</style>
      </head><body>
      <div style="background-image:url(/bg.jpg);color:red">hi</div>
      </body></html>`;
    const { html } = await processHtml(input, BASE, { text: false, mini: true });
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("as=\"font\"");
    expect(html).not.toContain("@font-face");
    expect(html).not.toContain("bg.jpg");
    // 装飾以外の宣言は残す
    expect(html).toContain("color:red");
  });

  it("normal mode keeps default image width/quality (not the mini values)", async () => {
    const input = `<html><body><img src="/pic.jpg"></body></html>`;
    const { html } = await processHtml(input, BASE, { text: false });
    expect(html).not.toMatch(/w=400&q=35/);
  });
});
