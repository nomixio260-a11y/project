/**
 * GET /interact?sid=&type=&ref=&value=&dy=
 * ライブ操作モードの操作エンドポイント。既存セッションの実ページ上にクリック/入力/
 * スクロール等を再現し、最適化HTMLの新しいスナップショットを返す。
 *
 * 親シェル(app.js)はiframe内の非リンク要素クリックや入力を捕捉し、対象の data-dsp-ref を
 * 付けてここへ遷移させる。転送は最適化HTMLのみ（映像なし）で省データを維持する。
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import {
  interactLiveSession,
  snapshotLiveSession,
  SessionGoneError,
  type LiveAction,
  type LiveActionType,
} from "../pipeline/liveSession.js";
import { sendLiveSnapshot } from "./liveResponse.js";
import { SsrfError } from "../security/ssrf.js";
import { renderErrorPage } from "./errorPage.js";

interface InteractQuery {
  sid: string;
  type: LiveActionType;
  ref?: string;
  value?: string;
  dy?: number;
  text?: string;
  dw?: number;
  dpr?: number;
}

const interactSchema = {
  querystring: {
    type: "object",
    required: ["sid", "type"],
    properties: {
      sid: { type: "string", pattern: "^[a-f0-9]{32}$" },
      type: { type: "string", enum: ["click", "input", "scroll", "reload", "back"] },
      ref: { type: "string", pattern: "^[0-9]{1,9}$" },
      value: { type: "string", maxLength: 4096 },
      dy: { type: "integer", minimum: -100000, maximum: 100000 },
      text: { type: "string", enum: ["0", "1"] },
      dw: { type: "integer", minimum: 16, maximum: 4096 },
      dpr: { type: "number", minimum: 1, maximum: 4 },
    },
  },
};

/** 期限切れ時に親シェルが現在URLを再オープンするための軽量ページ。 */
function sessionGonePage(): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="dsp-session-gone" content="1"></head>
<body><p>セッションの有効期限が切れました。ページを再読み込みします。</p></body></html>`;
}

export async function registerInteract(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: InteractQuery }>(
    "/interact",
    { schema: interactSchema },
    async (req, reply) => {
      const { sid, type, ref, value, dy, dw, dpr } = req.query;
      const text = req.query.text === "1";

      if (!config.enableLiveSessions) {
        reply.code(409).header("content-type", "text/html; charset=utf-8");
        return reply.send(sessionGonePage());
      }

      const action: LiveAction = { type, ref, value, dy };
      try {
        const snap = await interactLiveSession(sid, action);
        return await sendLiveSnapshot(reply, snap, { text, dw, dpr });
      } catch (err) {
        if (err instanceof SessionGoneError) {
          reply.code(409).header("content-type", "text/html; charset=utf-8");
          return reply.send(sessionGonePage());
        }
        if (err instanceof SsrfError) {
          reply.code(400).header("content-type", "text/html; charset=utf-8");
          return reply.send(renderErrorPage(req.url, err.message));
        }
        // 操作失敗（要素消失/タイムアウト等）はセッション自体は生存している可能性が高い。
        // 現在のDOMを取り直してUIを壊さず復帰させる。
        req.log.warn({ err, sid, type }, "live interact failed, returning current snapshot");
        try {
          const snap = await snapshotLiveSession(sid);
          return await sendLiveSnapshot(reply, snap, { text, dw, dpr });
        } catch {
          reply.code(409).header("content-type", "text/html; charset=utf-8");
          return reply.send(sessionGonePage());
        }
      }
    },
  );
}
