/**
 * 環境変数ベースの設定。上限・タイムアウトは全てここに集約する。
 */

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: intEnv("PORT", 3000),
  host: process.env.HOST ?? "0.0.0.0",

  /** 上流fetchのタイムアウト（ミリ秒） */
  fetchTimeoutMs: intEnv("FETCH_TIMEOUT_MS", 10_000),
  /** リダイレクト追従の上限 */
  maxRedirections: intEnv("MAX_REDIRECTIONS", 5),

  /** HTML/テキスト系レスポンスのサイズ上限（バイト） */
  maxHtmlBytes: intEnv("MAX_HTML_BYTES", 10 * 1024 * 1024),
  /** 画像ソースのサイズ上限（バイト） */
  maxImageBytes: intEnv("MAX_IMAGE_BYTES", 15 * 1024 * 1024),
  /** 動画ソースのサイズ上限（バイト） */
  maxVideoBytes: intEnv("MAX_VIDEO_BYTES", 200 * 1024 * 1024),

  /** 画像最適化の既定値 */
  imageDefaultWidth: intEnv("IMAGE_DEFAULT_WIDTH", 800),
  imageDefaultQuality: intEnv("IMAGE_DEFAULT_QUALITY", 60),
  imageMaxWidth: intEnv("IMAGE_MAX_WIDTH", 1600),

  /** 同時に走らせる動画トランスコードの上限（CPU枯渇防止） */
  maxConcurrentTranscodes: intEnv("MAX_CONCURRENT_TRANSCODES", 2),

  /** SSRF: プライベート/ループバック等への接続を許可する（開発・テスト用） */
  allowPrivateHosts: process.env.ALLOW_PRIVATE_HOSTS === "1",

  /** レート制限（1分あたりのリクエスト数） */
  rateLimitMax: intEnv("RATE_LIMIT_MAX", 120),
} as const;

export type AppConfig = typeof config;
