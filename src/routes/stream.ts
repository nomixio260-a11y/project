/**
 * WS /stream?url=&dw=&dpr= — 映像ストリーミング方式のリモートブラウザ。
 *
 * サーバー側ページの画面をJPEGフレームとして配信し、クライアントからの
 * マウス/キーボード/スクロール/ナビゲーションを実ページへ送り返す。
 *
 * サーバー→クライアント: {t:"ready",vw,vh,url} / {t:"frame",data} / {t:"url",url} / {t:"error",message}
 * クライアント→サーバー: InputMessage(JSON)
 */
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { config } from "../config.js";
import {
  BrowserStream,
  streamSlotsAvailable,
  type InputMessage,
} from "../pipeline/screencast.js";
import { SsrfError } from "../security/ssrf.js";

/** 稼働中ストリーム（graceful shutdownで一括クローズ） */
const liveStreams = new Set<BrowserStream>();

export async function closeAllStreams(): Promise<void> {
  const all = [...liveStreams];
  liveStreams.clear();
  await Promise.all(all.map((s) => s.close()));
}

function send(socket: WebSocket, obj: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
}

/** 受信メッセージを検証してInputMessageに正規化（不正は破棄）。 */
function parseInput(raw: string, vw: number, vh: number): InputMessage | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const t = m.type;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cx = (v: unknown): number => Math.max(0, Math.min(vw, num(v)));
  const cy = (v: unknown): number => Math.max(0, Math.min(vh, num(v)));
  const btn = (v: unknown): "left" | "right" | "middle" =>
    v === "right" || v === "middle" ? v : "left";
  switch (t) {
    case "mousemove":
      return { type: "mousemove", x: cx(m.x), y: cy(m.y), buttons: num(m.buttons) };
    case "mousedown":
      return { type: "mousedown", x: cx(m.x), y: cy(m.y), button: btn(m.button) };
    case "mouseup":
      return { type: "mouseup", x: cx(m.x), y: cy(m.y), button: btn(m.button) };
    case "wheel":
      return {
        type: "wheel",
        x: cx(m.x),
        y: cy(m.y),
        deltaX: num(m.deltaX),
        deltaY: num(m.deltaY),
      };
    case "key":
      return typeof m.key === "string" ? { type: "key", key: m.key } : null;
    case "text":
      return typeof m.text === "string" ? { type: "text", text: m.text } : null;
    case "navigate":
      return typeof m.url === "string" && /^https?:\/\//.test(m.url)
        ? { type: "navigate", url: m.url }
        : null;
    default:
      return null;
  }
}

export async function registerStream(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { url?: string; dw?: number; dpr?: number } }>(
    "/stream",
    { websocket: true },
    (socket: WebSocket, req) => {
      const url = req.query.url;
      if (!config.enableLiveSessions) {
        send(socket, { t: "error", message: "ライブ操作モードは無効です" });
        socket.close();
        return;
      }
      if (!url || !/^https?:\/\//.test(url)) {
        send(socket, { t: "error", message: "URLが不正です" });
        socket.close();
        return;
      }
      if (!streamSlotsAvailable()) {
        send(socket, { t: "error", message: "同時接続数の上限です。しばらく後にお試しください" });
        socket.close();
        return;
      }

      const stream = new BrowserStream({ url, dw: req.query.dw, dpr: req.query.dpr });
      liveStreams.add(stream);
      let lastUrl = url;

      stream.onFrame((frame) => {
        send(socket, { t: "frame", data: frame.data });
        // SPA内ナビゲーション等でURLが変わったら通知（アドレスバー同期）
        const cur = stream.currentUrl();
        if (cur !== lastUrl) {
          lastUrl = cur;
          send(socket, { t: "url", url: cur });
        }
      });

      const cleanup = (): void => {
        liveStreams.delete(stream);
        void stream.close();
      };

      stream
        .start()
        .then(() => {
          send(socket, {
            t: "ready",
            vw: stream.viewport.width,
            vh: stream.viewport.height,
            url: stream.currentUrl(),
          });
        })
        .catch((err: unknown) => {
          const message =
            err instanceof SsrfError
              ? err.message
              : err instanceof Error
                ? err.message
                : "ストリームの開始に失敗しました";
          req.log.warn({ err, url }, "stream start failed");
          send(socket, { t: "error", message });
          cleanup();
          socket.close();
        });

      socket.on("message", (raw: Buffer) => {
        const msg = parseInput(raw.toString("utf8"), stream.viewport.width, stream.viewport.height);
        if (msg) void stream.input(msg).catch(() => {});
      });
      socket.on("close", cleanup);
      socket.on("error", cleanup);
    },
  );
}
