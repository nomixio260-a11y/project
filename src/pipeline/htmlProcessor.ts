/**
 * 中核のHTML加工パイプライン。
 * cheerioでDOMを解析し、スクリプト/広告を除去、リンク/画像/動画を
 * プロキシ経由に書き換え、CSSをインライン最小化、最後にHTMLを最小化する。
 */
import * as cheerio from "cheerio";
import { minify as htmlMinify } from "html-minifier-terser";
import { AD_SELECTORS, isBlockedHost } from "./adFilter.js";
import {
  toAbsolute,
  toProxyUrl,
  toImageUrl,
  toVideoUrl,
  effectiveImageWidth,
} from "./urlRewriter.js";
import { processCss } from "./cssProcessor.js";
import { config } from "../config.js";
import type { ProcessedHtml, RewriteOptions } from "../types.js";

const PLAY_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='30' fill='%23000' opacity='.55'/%3E%3Cpath d='M26 20l18 12-18 12z' fill='%23fff'/%3E%3C/svg%3E";

/**
 * HTMLを加工する。
 * @param html  元のHTML文字列（UTF-8にデコード済み）
 * @param finalUrl  リダイレクト後の最終URL（URL解決の基準）
 * @param opts  text優先モード等
 */
export async function processHtml(
  html: string,
  finalUrl: string,
  opts: RewriteOptions,
): Promise<ProcessedHtml> {
  const originalBytes = Buffer.byteLength(html, "utf8");
  const $ = cheerio.load(html);

  // 1) base href を解決の基準にし、その後 <base> を除去
  let base = finalUrl;
  const baseHref = $("base[href]").first().attr("href");
  if (baseHref) {
    const absBase = toAbsolute(baseHref, finalUrl);
    if (absBase) base = absBase;
  }
  $("base").remove();

  // 2) 広告・スクリプト・トラッカー除去
  for (const sel of AD_SELECTORS) {
    try {
      $(sel).remove();
    } catch {
      // 不正なセレクタは無視
    }
  }
  // ブロックホストを参照する要素を除去
  $("[src],[href]").each((_, el) => {
    const e = $(el);
    const ref = e.attr("src") ?? e.attr("href");
    if (ref) {
      const abs = toAbsolute(ref, base);
      if (abs && isBlockedHost(abs)) e.remove();
    }
  });
  // インラインイベントハンドラ属性を除去（onclick等）
  $("*").each((_, el) => {
    if (el.type !== "tag") return;
    for (const attr of Object.keys(el.attribs ?? {})) {
      if (/^on/i.test(attr)) $(el).removeAttr(attr);
    }
  });

  // 3) charset正規化（出力は常にUTF-8）
  $("meta[charset]").remove();
  $("meta[http-equiv='Content-Type'], meta[http-equiv='content-type']").remove();
  if ($("head").length === 0) $("html").prepend("<head></head>");
  $("head").prepend('<meta charset="utf-8">');

  // 4) ナビゲーションリンクの書き換え
  $("a[href]").each((_, el) => {
    const e = $(el);
    const abs = toAbsolute(e.attr("href")!, base);
    if (abs) e.attr("href", toProxyUrl(abs, opts));
    else e.removeAttr("href");
  });
  $("area[href]").each((_, el) => {
    const e = $(el);
    const abs = toAbsolute(e.attr("href")!, base);
    if (abs) e.attr("href", toProxyUrl(abs, opts));
  });
  // GETフォームのactionをプロキシ経由に（POSTは据え置き）
  $("form").each((_, el) => {
    const e = $(el);
    const method = (e.attr("method") ?? "get").toLowerCase();
    const action = e.attr("action");
    if (method === "get" && action) {
      const abs = toAbsolute(action, base);
      if (abs) e.attr("action", "/browse").attr("data-target", abs);
    }
  });

  // 5) メディア処理（テキストモードでは除去、通常は最適化/書き換え）
  if (opts.text) {
    $("img, picture, source, video, audio, iframe, svg, canvas, object, embed").remove();
    // 背景画像のインラインstyleも除去
    $("[style]").each((_, el) => {
      const e = $(el);
      const style = e.attr("style") ?? "";
      e.attr("style", style.replace(/background(-image)?\s*:[^;]*;?/gi, ""));
    });
  } else {
    // 省データ最大(Opera Mini相当)では画像をより小さく・低品質に再圧縮する
    const imgWidth = opts.mini
      ? Math.min(config.miniImageWidth, effectiveImageWidth(opts))
      : effectiveImageWidth(opts);
    const imgQuality = opts.mini ? config.miniImageQuality : undefined;
    rewriteImages($, base, imgWidth, imgQuality);
    rewriteVideos($, base);
    rewriteEmbeds($, base);
  }

  // 省データ最大: Webフォント・投機読み込み・背景画像など「見た目用の重い通信」を全除去
  if (opts.mini) {
    stripHeavyForMini($);
  }

  // 6) スタイルシート処理（<style> 最小化、<link> はインライン化せず最適化のみ）
  $("style").each((_, el) => {
    const e = $(el);
    const css = e.html() ?? "";
    e.html(processCss(css, base, opts));
  });
  // 外部CSSは /browse 経由にせず、テキストモードでは除去・通常はそのまま絶対化
  $("link[rel='stylesheet'][href]").each((_, el) => {
    const e = $(el);
    if (opts.text) {
      e.remove();
      return;
    }
    const abs = toAbsolute(e.attr("href")!, base);
    if (abs) e.attr("href", abs);
  });
  // プリロード/プリフェッチ/dns-prefetch等の投機的リソースヒントを除去（通信削減）
  $("link[rel='preload'], link[rel='prefetch'], link[rel='preconnect'], link[rel='dns-prefetch']").remove();

  // 7) CSP（スクリプトは除去済みなので 'none' にできる）メタを付与
  $("head").append(
    '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'">',
  );
  // 節約メーター用に元HTMLのバイト数を埋め込む（親シェルが読み取る）
  $("head").append(`<meta name="dsp-original-bytes" content="${originalBytes}">`);

  // 8) HTML最小化
  let outHtml = $.html();
  try {
    outHtml = await htmlMinify(outHtml, {
      collapseWhitespace: true,
      removeComments: true,
      removeRedundantAttributes: true,
      minifyCSS: true,
      keepClosingSlash: true,
      removeEmptyAttributes: true,
    });
  } catch {
    // 失敗時は非最小化版を使う
  }

  return {
    html: outHtml,
    originalBytes,
    processedBytes: Buffer.byteLength(outHtml, "utf8"),
  };
}

/** <img> と srcset を /img 経由に書き換え（width はデバイスに合わせる） */
function rewriteImages(
  $: cheerio.CheerioAPI,
  base: string,
  imgWidth: number,
  imgQuality?: number,
): void {
  $("img").each((_, el) => {
    const e = $(el);
    // lazy-load属性を実体化
    const lazySrc = e.attr("data-src") ?? e.attr("data-original") ?? e.attr("data-lazy-src");
    const src = e.attr("src") ?? lazySrc;
    if (src) {
      const abs = toAbsolute(src, base);
      if (abs) e.attr("src", toImageUrl(abs, { w: imgWidth, q: imgQuality }));
      else e.removeAttr("src");
    }
    e.removeAttr("data-src").removeAttr("data-original").removeAttr("data-lazy-src");
    e.attr("loading", "lazy");

    // srcset はデバイス幅で最適化済みの単一srcに集約し、重複DL候補を排除する
    e.removeAttr("srcset").removeAttr("data-srcset").removeAttr("sizes");
  });

  // <picture> の複数候補も不要（imgのsrcに集約）。source を除去して通信を削減
  $("picture source").remove();
}

/** <video>/<source> 直リンク動画を /video 経由（トランスコード）に書き換え */
function rewriteVideos($: cheerio.CheerioAPI, base: string): void {
  $("video").each((_, el) => {
    const e = $(el);
    e.attr("preload", "none"); // 先読み通信を止める
    e.removeAttr("autoplay");
    e.attr("controls", "");
    e.addClass("dsp-video");

    const directSrc = e.attr("src");
    if (directSrc) {
      const abs = toAbsolute(directSrc, base);
      // コーデックはクライアントが能力判定して差し替える（data-* に候補を持たせる）
      if (abs) {
        e.attr("src", toVideoUrl(abs, "h264"));
        e.attr("data-dsp-src", abs);
      }
    }
    e.find("source").each((__, s) => {
      const se = $(s);
      const ssrc = se.attr("src");
      if (ssrc) {
        const abs = toAbsolute(ssrc, base);
        if (abs) {
          se.attr("src", toVideoUrl(abs, "h264"));
          se.attr("data-dsp-src", abs);
          se.removeAttr("type");
        }
      }
    });
  });
}

/** YouTube/Vimeo等の埋め込みiframeを click-to-play プレースホルダに置換 */
function rewriteEmbeds($: cheerio.CheerioAPI, base: string): void {
  $("iframe[src]").each((_, el) => {
    const e = $(el);
    const src = e.attr("src");
    if (!src) return;
    const abs = toAbsolute(src, base);
    if (!abs) {
      e.remove();
      return;
    }
    const isVideoEmbed = /youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|dailymotion\.com/i.test(abs);
    if (isVideoEmbed) {
      // click-to-play: タップ時のみ元iframeを生成する軽量プレースホルダ
      const placeholder = `<div class="dsp-embed" data-dsp-embed="${escapeAttr(abs)}" role="button" tabindex="0" style="position:relative;background:#111;min-height:200px;display:flex;align-items:center;justify-content:center;cursor:pointer"><img src="${PLAY_ICON}" alt="動画を再生" width="64" height="64"></div>`;
      e.replaceWith(placeholder);
    } else {
      // 非動画iframeは絶対化のみ（広告系は既に除去済み）
      e.attr("src", abs);
    }
  });
}

/**
 * 省データ最大(Opera Mini相当)で「見た目のための重い通信」を除去する。
 * Webフォント（数百KB級）をシステムフォントに置換し、背景画像の読み込みも止める。
 */
function stripHeavyForMini($: cheerio.CheerioAPI): void {
  // Webフォントの読み込みを除去（フォントは最も無駄になりやすい通信のひとつ）
  $("link[rel='preload'][as='font']").remove();
  $(
    "link[href*='fonts.googleapis.com'],link[href*='fonts.gstatic.com'],link[href*='use.typekit.net'],link[href*='fontawesome']",
  ).remove();
  // インライン<style>内の @font-face を除去（外部CSSは据え置くが web font は読まれにくくなる）
  $("style").each((_, el) => {
    const e = $(el);
    const css = e.html() ?? "";
    const cleaned = css.replace(/@font-face\s*\{[^}]*\}/gi, "");
    if (cleaned !== css) e.html(cleaned);
  });
  // インラインstyleの背景画像URLを除去（装飾画像の通信を削減）
  $("[style]").each((_, el) => {
    const e = $(el);
    const style = e.attr("style") ?? "";
    const cleaned = style.replace(/background(-image)?\s*:[^;]*url\([^)]*\)[^;]*;?/gi, "");
    if (cleaned !== style) e.attr("style", cleaned);
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
