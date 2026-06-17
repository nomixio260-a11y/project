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

  /**
   * アクセストークン。設定されている場合のみ認証ゲートが有効になり、
   * `/?token=...` でCookieを発行した利用者だけがプロキシを使える。
   * 公開トンネルでのオープンプロキシ濫用を防ぐ（未設定なら認証なし）。
   */
  accessToken: process.env.ACCESS_TOKEN ?? "",

  /** SPA対応: ヘッドレスChromiumでJSを実行して描画する機能を有効化（既定ON）。
   *  実際の可否は起動プローブ(isRendererAvailable)で最終判定し、未導入時は静的fetchへフォールバック。 */
  enableRenderer: process.env.ENABLE_RENDERER !== "0",
  /** 同時レンダリング数の上限（メモリ保護） */
  maxConcurrentRenders: intEnv("MAX_CONCURRENT_RENDERS", 2),
  /** レンダリング全体のタイムアウト（ミリ秒） */
  renderTimeoutMs: intEnv("RENDER_TIMEOUT_MS", 15_000),
  /** networkidle待ちの予算（ミリ秒）。これを超えても描画結果を採用する */
  renderSettleMs: intEnv("RENDER_SETTLE_MS", 2_500),
  /** レンダリング時に重いリソース（メディア/フォント/画像）をブロックして帯域節約（既定ON） */
  renderBlockMedia: process.env.RENDER_BLOCK_MEDIA !== "0",
  /** Chromiumを --no-sandbox で起動（コンテナ/root環境で必要。OSサンドボックスは弱まる） */
  renderNoSandbox: process.env.RENDER_NO_SANDBOX === "1",
  /** ヘッドレスブラウザでTLS証明書エラーを無視する（既定ON）。
   *  企業/クラウドのTLS傍受プロキシ経由だとChromiumが独自CAを信頼せず ERR_CERT_AUTHORITY_INVALID で
   *  HTTPSが開けないため。undiciの静的取得は別途システムCA/NODE_EXTRA_CA_CERTSで検証される。 */
  renderIgnoreHttpsErrors: process.env.RENDER_IGNORE_HTTPS_ERRORS !== "0",

  /** Opera Mini相当の「省データ最大」モードの圧縮パラメータ。
   *  サーバーでJS実行→静的化した上で、画像を強圧縮・Webフォント等を全除去して極限まで削る。 */
  miniImageWidth: intEnv("MINI_IMAGE_WIDTH", 400),
  miniImageQuality: intEnv("MINI_IMAGE_QUALITY", 35),
} as const;

export type AppConfig = typeof config;
