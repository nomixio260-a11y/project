/**
 * CSS最小化と、CSS内 url(...) 参照の書き換え。
 */
import { minify as cssoMinify } from "csso";
import { toAbsolute, toImageUrl } from "./urlRewriter.js";
import type { RewriteOptions } from "../types.js";

/**
 * CSS文字列内の url(...) を解決する。
 * - ラスタ画像（拡張子で判定）は /img 経由に
 * - フォント等その他は絶対URLに
 * - テキストモードでは背景画像系の url() を none に潰すのは難しいので、
 *   ここでは絶対化のみ行い、画像化はしない（テキストモードはHTML側でbg除去）
 */
export function rewriteCssUrls(css: string, base: string, opts: RewriteOptions): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, _quote, rawUrl) => {
    const abs = toAbsolute(String(rawUrl), base);
    if (!abs) return match;
    if (!opts.text && /\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i.test(abs)) {
      return `url("${toImageUrl(abs)}")`;
    }
    return `url("${abs}")`;
  });
}

/** CSSを最小化（失敗時は元のCSSを返す） */
export function minifyCss(css: string): string {
  try {
    return cssoMinify(css).css;
  } catch {
    return css;
  }
}

/** url書き換え + 最小化をまとめて行う */
export function processCss(css: string, base: string, opts: RewriteOptions): string {
  return minifyCss(rewriteCssUrls(css, base, opts));
}
