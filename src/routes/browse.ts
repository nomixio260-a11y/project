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
import { isHtml } from "../lib/contentType.js";
import { SsrfError } from "../security/ssrf.js";
import { renderErrorPage } from "./errorPage.js";

interface BrowseQuery {
  url: string;
  text?: string;
}

const browseSchema = {
  querystring: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", pattern: "^https?://" },
      text: { type: "string", enum: ["0", "1"] },
    },
  },
};

export async function registerBrowse(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: BrowseQuery }>("/browse", { schema: browseSchema }, async (req, reply) => {
    const { url } = req.query;
    const text = req.query.text === "1";

    try {
      const result = await safeFetch(url, { maxBytes: config.maxHtmlBytes });

      if (!result.contentType || !isHtml(result.contentType)) {
        // HTML以外は加工せずパススルー（サイズは取得時に制限済み）
        reply
          .header("content-type", result.contentType ?? "application/octet-stream")
          .header("x-content-type-options", "nosniff");
        return reply.send(result.body);
      }

      const html = decodeHtml(result.body, result.charset);
      const processed = await processHtml(html, result.finalUrl, { text });

      reply
        .header("content-type", "text/html; charset=utf-8")
        .header("x-content-type-options", "nosniff")
        .header("x-dsp-original-bytes", String(processed.originalBytes))
        .header("x-dsp-processed-bytes", String(processed.processedBytes));
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
