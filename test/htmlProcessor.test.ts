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
