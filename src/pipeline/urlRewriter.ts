/**
 * URL書き換えヘルパー。相対→絶対の解決と、プロキシ経由ルーティングへの変換を一元化。
 */
import type { RewriteOptions, VideoCodec } from "../types.js";
import { config } from "../config.js";

/** 触らないスキーム（そのまま据え置く） */
const SKIP_SCHEMES = /^(data:|mailto:|tel:|blob:|#|about:)/i;

/** baseを基準に相対URLを絶対化。失敗時はnull。 */
export function toAbsolute(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (SKIP_SCHEMES.test(trimmed)) return null;
  if (/^javascript:/i.test(trimmed)) return null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

/** ナビゲーションリンクを /browse 経由に変換（textフラグを伝播） */
export function toProxyUrl(absUrl: string, opts: RewriteOptions): string {
  const params = new URLSearchParams({ url: absUrl });
  if (opts.text) params.set("text", "1");
  return `/browse?${params.toString()}`;
}

/** 画像URLを /img 経由（最適化）に変換 */
export function toImageUrl(
  absUrl: string,
  imgOpts?: { w?: number; q?: number },
): string {
  const params = new URLSearchParams({ url: absUrl });
  params.set("w", String(imgOpts?.w ?? config.imageDefaultWidth));
  params.set("q", String(imgOpts?.q ?? config.imageDefaultQuality));
  return `/img?${params.toString()}`;
}

/** 動画URLを /video 経由（トランスコード）に変換 */
export function toVideoUrl(absUrl: string, codec: VideoCodec): string {
  const params = new URLSearchParams({ url: absUrl, codec });
  return `/video?${params.toString()}`;
}

/**
 * srcset属性（"url 1x, url 2x" / "url 300w, ..."）を解析し、
 * 各候補URLをmapで変換して再構築する。
 */
export function rewriteSrcset(
  srcset: string,
  base: string,
  mapUrl: (abs: string) => string,
): string {
  return srcset
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return null;
      const spaceIdx = trimmed.search(/\s/);
      const urlPart = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const descriptor = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx).trim();
      const abs = toAbsolute(urlPart, base);
      if (!abs) return null;
      const mapped = mapUrl(abs);
      return descriptor ? `${mapped} ${descriptor}` : mapped;
    })
    .filter((x): x is string => x !== null)
    .join(", ");
}
