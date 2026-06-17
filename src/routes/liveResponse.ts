/**
 * ライブセッションのスナップショット(LiveSnapshot)を、既存の節約パイプライン(processHtml)に
 * 通して送出する共通処理。/browse のライブ初回ロードと /interact の双方が使う。
 */
import type { FastifyReply } from "fastify";
import { processHtml } from "../pipeline/htmlProcessor.js";
import type { LiveSnapshot } from "../pipeline/liveSession.js";

export interface LiveSendOptions {
  text: boolean;
  dw?: number;
  dpr?: number;
}

export async function sendLiveSnapshot(
  reply: FastifyReply,
  snap: LiveSnapshot,
  opts: LiveSendOptions,
): Promise<FastifyReply> {
  // render:"on" は「リンク=描画継続」を示すだけ。実際の操作は親シェルがsid経由で送る。
  const processed = await processHtml(snap.html, snap.finalUrl, {
    text: opts.text,
    dw: opts.dw,
    dpr: opts.dpr,
    render: "on",
  });
  // 親シェルが後続操作の送信先(sid)と現在URL（SPA内遷移後の同期用）を知るためのメタを注入
  const meta =
    `<meta name="dsp-session" content="${snap.sid}">` +
    `<meta name="dsp-url" content="${escapeAttr(snap.finalUrl)}">`;
  const html = processed.html.replace(/<\/head>/i, `${meta}</head>`);

  reply
    .header("content-type", "text/html; charset=utf-8")
    .header("x-content-type-options", "nosniff")
    .header("x-dsp-original-bytes", String(processed.originalBytes))
    .header("x-dsp-processed-bytes", String(Buffer.byteLength(html, "utf8")))
    .header("x-dsp-rendered", "1")
    .header("x-dsp-session", snap.sid);
  return reply.send(html);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
