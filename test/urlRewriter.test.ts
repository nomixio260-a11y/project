import { describe, it, expect } from "vitest";
import {
  toAbsolute,
  toProxyUrl,
  toImageUrl,
  toVideoUrl,
  rewriteSrcset,
  effectiveImageWidth,
} from "../src/pipeline/urlRewriter.js";
import { config } from "../src/config.js";

const BASE = "https://example.com/dir/page.html";

describe("toAbsolute", () => {
  it("resolves relative paths against base", () => {
    expect(toAbsolute("../img/a.png", BASE)).toBe("https://example.com/img/a.png");
    expect(toAbsolute("/root.html", BASE)).toBe("https://example.com/root.html");
    expect(toAbsolute("sub/x", BASE)).toBe("https://example.com/dir/sub/x");
  });

  it("resolves protocol-relative URLs", () => {
    expect(toAbsolute("//cdn.example.com/a.js", BASE)).toBe("https://cdn.example.com/a.js");
  });

  it("returns null for skipped/invalid schemes", () => {
    expect(toAbsolute("javascript:alert(1)", BASE)).toBeNull();
    expect(toAbsolute("mailto:a@b.com", BASE)).toBeNull();
    expect(toAbsolute("data:image/png;base64,xxx", BASE)).toBeNull();
    expect(toAbsolute("#section", BASE)).toBeNull();
    expect(toAbsolute("   ", BASE)).toBeNull();
  });
});

describe("proxy url helpers", () => {
  it("routes navigation through /browse and propagates text flag", () => {
    expect(toProxyUrl("https://a.com/x", { text: false })).toBe(
      "/browse?url=https%3A%2F%2Fa.com%2Fx",
    );
    expect(toProxyUrl("https://a.com/x", { text: true })).toBe(
      "/browse?url=https%3A%2F%2Fa.com%2Fx&text=1",
    );
  });

  it("routes images through /img with defaults", () => {
    const u = toImageUrl("https://a.com/i.jpg");
    expect(u).toContain("/img?url=https%3A%2F%2Fa.com%2Fi.jpg");
    expect(u).toContain("w=");
    expect(u).toContain("q=");
  });

  it("propagates device hints (dw/dpr) through navigation links", () => {
    expect(toProxyUrl("https://a.com/x", { text: true, dw: 400, dpr: 2 })).toBe(
      "/browse?url=https%3A%2F%2Fa.com%2Fx&text=1&dw=400&dpr=2",
    );
    expect(toProxyUrl("https://a.com/x", { text: false, dw: 360 })).toBe(
      "/browse?url=https%3A%2F%2Fa.com%2Fx&dw=360",
    );
  });

  it("routes videos through /video with codec", () => {
    expect(toVideoUrl("https://a.com/v.mp4", "av1")).toBe(
      "/video?url=https%3A%2F%2Fa.com%2Fv.mp4&codec=av1",
    );
  });
});

describe("effectiveImageWidth", () => {
  it("falls back to the default width when no device hint is given", () => {
    expect(effectiveImageWidth({ text: false })).toBe(config.imageDefaultWidth);
  });

  it("scales by device width and DPR (DPR capped at 2)", () => {
    expect(effectiveImageWidth({ text: false, dw: 360, dpr: 1 })).toBe(360);
    expect(effectiveImageWidth({ text: false, dw: 360, dpr: 3 })).toBe(720); // 3xは2xに丸め
  });

  it("never exceeds the configured max width", () => {
    expect(effectiveImageWidth({ text: false, dw: 4000, dpr: 2 })).toBe(config.imageMaxWidth);
  });

  it("clamps to a sane minimum for tiny widths", () => {
    expect(effectiveImageWidth({ text: false, dw: 10, dpr: 1 })).toBe(64);
  });
});

describe("rewriteSrcset", () => {
  it("rewrites each candidate preserving descriptors", () => {
    const out = rewriteSrcset("a.png 1x, b.png 2x", BASE, (abs) => `/img?url=${encodeURIComponent(abs)}`);
    expect(out).toContain("1x");
    expect(out).toContain("2x");
    expect(out).toContain(encodeURIComponent("https://example.com/dir/a.png"));
  });

  it("drops invalid candidates gracefully", () => {
    const out = rewriteSrcset("javascript:x 1x, ok.png 2x", BASE, (abs) => abs);
    expect(out).not.toContain("javascript");
    expect(out).toContain("ok.png");
  });
});
