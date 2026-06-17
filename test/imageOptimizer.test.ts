import { describe, it, expect, beforeAll } from "vitest";
import sharp from "sharp";
import { optimizeImage } from "../src/pipeline/imageOptimizer.js";

let pngFixture: Buffer;

beforeAll(async () => {
  // 600x400 の赤い矩形PNGを生成
  pngFixture = await sharp({
    create: { width: 600, height: 400, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
});

describe("optimizeImage", () => {
  it("transcodes to WebP and respects width cap", async () => {
    const out = await optimizeImage(pngFixture, { width: 300, quality: 60 });
    expect(out.contentType).toBe("image/webp");
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(300);
  });

  it("does not enlarge beyond original", async () => {
    const out = await optimizeImage(pngFixture, { width: 1600, quality: 60 });
    const meta = await sharp(out.data).metadata();
    expect(meta.width).toBe(600); // 元サイズを超えない
  });

  it("passes SVG through unchanged", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
    const out = await optimizeImage(svg, { width: 100, quality: 60 }, "image/svg+xml");
    expect(out.contentType).toBe("image/svg+xml");
    expect(out.data).toBe(svg);
  });

  it("produces smaller output than a large source", async () => {
    const big = await sharp({
      create: { width: 2000, height: 2000, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .png()
      .toBuffer();
    const out = await optimizeImage(big, { width: 800, quality: 50 });
    expect(out.data.length).toBeLessThan(big.length);
  });

  it("emits AVIF when requested", async () => {
    const photo = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 150, b: 90 } },
    })
      .png()
      .toBuffer();
    const webp = await optimizeImage(photo, { width: 400, quality: 35, format: "webp" });
    const avif = await optimizeImage(photo, { width: 400, quality: 35, format: "avif" });
    expect(webp.contentType).toBe("image/webp");
    expect(avif.contentType).toBe("image/avif");
    expect((await sharp(avif.data).metadata()).format).toBe("heif"); // avif container
    // どちらも元より大幅に小さい（高圧縮）
    expect(avif.data.length).toBeLessThan(photo.length);
    expect(webp.data.length).toBeLessThan(photo.length);
  });
});
