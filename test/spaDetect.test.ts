import { describe, it, expect } from "vitest";
import { needsRendering } from "../src/lib/spaDetect.js";

describe("needsRendering", () => {
  it("detects an empty SPA root shell", () => {
    const html = `<!doctype html><html><head><title>App</title>
      <script src="/bundle.js"></script><script src="/vendor.js"></script><script>init()</script>
      </head><body><div id="root"></div></body></html>`;
    expect(needsRendering(html, "text/html")).toBe(true);
  });

  it("detects Next.js/Nuxt/Gatsby empty roots", () => {
    expect(needsRendering(`<body><div id="__next"></div></body>`, "text/html")).toBe(true);
    expect(needsRendering(`<body><div id="app"></div></body>`, "text/html")).toBe(true);
  });

  it("detects a noscript 'enable JavaScript' shell", () => {
    const html = `<html><body><noscript>You need to enable JavaScript to run this app.</noscript>
      <div></div><script src="/a.js"></script></body></html>`;
    expect(needsRendering(html, "text/html")).toBe(true);
  });

  it("returns false for a content-rich server-rendered page", () => {
    const body = "<p>" + "本文のテキストがたっぷりあります。".repeat(40) + "</p>";
    const html = `<html><head><title>記事</title></head><body><article>${body}</article>
      <script src="/analytics.js"></script></body></html>`;
    expect(needsRendering(html, "text/html")).toBe(false);
  });

  it("returns false for non-HTML content types", () => {
    expect(needsRendering("<div id=\"root\"></div>", "application/json")).toBe(false);
    expect(needsRendering("<div id=\"root\"></div>", "image/png")).toBe(false);
  });

  it("does not flag a near-empty page that lacks scripts", () => {
    expect(needsRendering("<html><body><p>hi</p></body></html>", "text/html")).toBe(false);
  });
});
