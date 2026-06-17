/**
 * GET /browse?url=<abs>&text=0|1
 * 対象ページを取得し、HTML加工して返す。HTML以外はパススルー（上限付き）。
 */
import type { FastifyInstance } from "fastify";
import iconv from "iconv-lite";
import * as cheerio from "cheerio";
import { config } from "../config.js";
import { safeFetch } from "../pipeline/fetcher.js";
import { processHtml } from "../pipeline/htmlProcessor.js";
import { needsRendering } from "../lib/spaDetect.js";
import { renderPage, isRendererAvailable } from "../pipeline/renderer.js";
import { openLiveSession } from "../pipeline/liveSession.js";
import { sendLiveSnapshot } from "./liveResponse.js";
import { isHtml } from "../lib/contentType.js";
import { SsrfError } from "../security/ssrf.js";
import { renderErrorPage } from "./errorPage.js";
import type { RenderMode } from "../types.js";

interface BrowseQuery {
  url: string;
  text?: string;
  dw?: number;
  dpr?: number;
  render?: RenderMode;
  /** ライブ操作モード（常駐セッションでの対話表示） */
  live?: string;
  /** 再利用するライブセッションID（親シェルが現在sidを伝播） */
  sid?: string;
}

const browseSchema = {
  querystring: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", pattern: "^https?://" },
      text: { type: "string", enum: ["0", "1"] },
      // デバイス表示幅(px)とピクセル比。画像を端末サイズに合わせて縮小する
      dw: { type: "integer", minimum: 16, maximum: 4096 },
      dpr: { type: "number", minimum: 1, maximum: 4 },
      // SPA描画モード: auto=ヒューリスティック検出 / on=強制 / off=無効
      render: { type: "string", enum: ["auto", "on", "off"] },
      // ライブ操作モード（常駐セッションで対話表示）
      live: { type: "string", enum: ["0", "1"] },
      sid: { type: "string", pattern: "^[a-f0-9]{32}$" },
    },
  },
};

export async function registerBrowse(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: BrowseQuery }>("/browse", { schema: browseSchema }, async (req, reply) => {
    const { url, dw, dpr, sid } = req.query;
    const text = req.query.text === "1";
    const mode: RenderMode = req.query.render ?? "auto";
    const live = req.query.live === "1";

    try {
      // ライブ操作モード: 常駐セッションを開いて（または再利用して）対話表示。
      // 失敗時は通常の取得/描画フローへフォールバックする。
      if (live && config.enableLiveSessions && (await isRendererAvailable())) {
        try {
          const snap = await openLiveSession(url, { dw, dpr, sid });
          return await sendLiveSnapshot(reply, snap, { text, dw, dpr });
        } catch (err) {
          if (err instanceof SsrfError) throw err;
          req.log.warn({ err, url }, "live session failed, falling back to static/render");
        }
      }

      const result = await safeFetch(url, { maxBytes: config.maxHtmlBytes });

      if (!result.contentType || !isHtml(result.contentType)) {
        // HTML以外は加工せずパススルー（サイズは取得時に制限済み）
        reply
          .header("content-type", result.contentType ?? "application/octet-stream")
          .header("x-content-type-options", "nosniff");
        return reply.send(result.body);
      }

      const staticHtml = decodeHtml(result.body, result.charset);

      // SPAレンダリング判定（on=強制 / auto=ヒューリスティック / off=無効）
      let htmlToProcess = staticHtml;
      let finalUrl = result.finalUrl;
      let rendered = false;
      let renderFallback = false;

      const wantRender =
        config.enableRenderer &&
        mode !== "off" &&
        (mode === "on" || needsRendering(staticHtml, result.contentType));

      if (wantRender) {
        if (await isRendererAvailable()) {
          try {
            // 描画は元URLから（リダイレクトSSRFをブラウザ経路でも再検証）
            const r = await renderPage(url, { dw, dpr, maxBytes: config.maxHtmlBytes });
            htmlToProcess = r.html;
            finalUrl = r.finalUrl;
            rendered = true;
          } catch (err) {
            req.log.warn({ err, url }, "render failed, falling back to static");
            renderFallback = true;
          }
        } else {
          renderFallback = true; // ブラウザ未導入等
        }
      }

      const processed = await processHtml(htmlToProcess, finalUrl, { text, dw, dpr, render: mode });

      reply
        .header("content-type", "text/html; charset=utf-8")
        .header("x-content-type-options", "nosniff")
        .header("x-dsp-original-bytes", String(processed.originalBytes))
        .header("x-dsp-processed-bytes", String(processed.processedBytes))
        .header("x-dsp-rendered", rendered ? "1" : "0");
      if (renderFallback) reply.header("x-dsp-render-fallback", "1");
      return reply.send(processed.html);
    } catch (err) {
      const status = err instanceof SsrfError ? 400 : 502;
      const message = err instanceof Error ? err.message : "不明なエラー";
      reply.code(status).header("content-type", "text/html; charset=utf-8");
      return reply.send(renderErrorPage(url, message));
    }
  });
}

/**
 * 文字コードをUTF-8へデコード。Content-Typeのcharset→<meta>の順で判定。
 */
function decodeHtml(body: Buffer, charsetHint: string | null): string {
  let charset = charsetHint;
  if (!charset || charset === "utf-8" || charset === "utf8") {
    // <meta charset> も確認（HTML先頭を仮にlatin1で覗く）
    const head = body.subarray(0, 4096).toString("latin1");
    const $ = cheerio.load(head);
    const metaCharset =
      $("meta[charset]").attr("charset") ??
      parseMetaHttpEquiv($("meta[http-equiv='Content-Type'], meta[http-equiv='content-type']").attr("content"));
    if (metaCharset) charset = metaCharset.toLowerCase();
  }

  if (charset && charset !== "utf-8" && charset !== "utf8" && iconv.encodingExists(charset)) {
    try {
      return iconv.decode(body, charset);
    } catch {
      // フォールスルー
    }
  }
  return body.toString("utf8");
}

function parseMetaHttpEquiv(content: string | undefined): string | null {
  if (!content) return null;
  const m = content.match(/charset=([\w-]+)/i);
  return m ? (m[1] ?? null) : null;
}
