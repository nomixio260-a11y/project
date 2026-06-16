/**
 * アクセストークン認証ゲート（任意）。
 * config.accessToken が設定されている場合のみ有効。
 *
 * 仕組み:
 *   - シェル `/` を `?token=...` 付きで開くとトークンを検証し、HttpOnly Cookie を発行する
 *   - 以降の同一オリジンのリクエスト（/browse, /img, /video, /public/*）は Cookie で認証
 *   - /healthz は常に許可（死活監視のため）
 *
 * これにより、公開トンネルで全世界にオープンプロキシを晒すのを防ぎ、
 * トークン付きURLを知る利用者だけが使えるようにする。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config.js";

const COOKIE = "dsp_token";

function tokenFromQuery(url: string): string | null {
  const qi = url.indexOf("?");
  if (qi === -1) return null;
  return new URLSearchParams(url.slice(qi + 1)).get("token");
}

function tokenFromCookie(req: FastifyRequest): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function unauthorizedHtml(): string {
  return (
    "<!doctype html><meta charset=utf-8><title>認証が必要です</title>" +
    '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#333">' +
    "<h1>🔒 認証が必要です</h1>" +
    "<p>このDataSaver Browserはアクセストークンで保護されています。" +
    "管理者から共有された <code>/?token=...</code> 付きのURLから開いてください。</p>"
  );
}

export function registerAccessGuard(app: FastifyInstance): void {
  if (!config.accessToken) return; // 未設定なら認証なし（従来通り）
  const token = config.accessToken;

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (path === "/healthz") return;

    // 有効なCookieがあれば通す
    if (tokenFromCookie(req) === token) return;

    // シェル(/)はクエリのトークンを検証し、Cookieを発行する
    if (path === "/" && tokenFromQuery(req.url) === token) {
      reply.header(
        "set-cookie",
        `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
      );
      return;
    }

    return reply.code(401).type("text/html; charset=utf-8").send(unauthorizedHtml());
  });
}
