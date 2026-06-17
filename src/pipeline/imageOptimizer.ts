/**
 * sharpによる画像のリサイズ + WebP変換。解凍爆弾対策に入力ピクセル数を制限。
 */
import sharp from "sharp";
import { config } from "../config.js";

export type ImageFormat = "webp" | "avif";

export interface OptimizeImageOptions {
  width: number;
  quality: number;
  /** 出力フォーマット。avifはwebpよりさらに小さい（既定webp） */
  format?: ImageFormat;
}

export interface OptimizedImage {
  data: Buffer;
  contentType: string;
}

/**
 * 入力画像バッファを width 上限でリサイズし、WebP/AVIFへ変換する。
 * SVGはベクタなのでそのまま返す（ラスタ化しない）。
 */
export async function optimizeImage(
  input: Buffer,
  opts: OptimizeImageOptions,
  sourceContentType?: string | null,
): Promise<OptimizedImage> {
  // SVGはそのまま（テキストベースで既に軽量、ラスタ化は逆効果になりうる）
  if (sourceContentType === "image/svg+xml" || isSvg(input)) {
    return { data: input, contentType: "image/svg+xml" };
  }

  const width = clamp(Math.round(opts.width), 16, config.imageMaxWidth);
  const quality = clamp(Math.round(opts.quality), 10, 90);
  const format: ImageFormat = opts.format === "avif" ? "avif" : "webp";

  const pipeline = sharp(input, {
    limitInputPixels: 64_000_000, // ~8000x8000、解凍爆弾対策
    failOn: "none",
  });

  const meta = await pipeline.metadata();
  // 元より拡大しない（withoutEnlargement）
  const resized = pipeline.resize({
    width: meta.width && meta.width < width ? meta.width : width,
    withoutEnlargement: true,
  });

  // AVIFはwebpより高圧縮（同品質で2〜3割小さい）。エンコードは重いので effort は控えめ。
  if (format === "avif") {
    const data = await resized.avif({ quality, effort: 3 }).toBuffer();
    return { data, contentType: "image/avif" };
  }
  const data = await resized.webp({ quality, effort: 4 }).toBuffer();
  return { data, contentType: "image/webp" };
}

function isSvg(buf: Buffer): boolean {
  const head = buf.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<svg") || head.startsWith("<?xml");
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
