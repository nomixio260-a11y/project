/**
 * Fastifyアプリの生成。プラグイン（圧縮・レート制限）とルートを登録する。
 */
import zlib from "node:zlib";
import Fastify, { type FastifyInstance } from "fastify";
import compress from "@fastify/compress";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { registerUi } from "./routes/ui.js";
import { registerBrowse } from "./routes/browse.js";
import { registerImage } from "./routes/image.js";
import { registerVideo } from "./routes/video.js";
import { registerAccessGuard } from "./security/accessGuard.js";
import { closeBrowser } from "./pipeline/renderer.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    // クエリのurlは長くなりうるのでヘッダ上限を緩める
    bodyLimit: 1024 * 1024,
  });

  // Brotli優先・gzipフォールバックでテキスト系を圧縮（画像/動画は除外）
  await app.register(compress, {
    global: true,
    encodings: ["br", "gzip"],
    // 既に圧縮済みのバイナリ（webp/avif/動画）は再圧縮しない
    customTypes: /^(text\/|application\/(json|javascript|xml)|image\/svg)/,
    // 通信量を最優先するデータセーバーなのでBrotliは最高圧縮率(11)に固定
    brotliOptions: {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      },
    },
    zlibOptions: { level: 9 },
  });

  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: "1 minute",
  });

  // アクセストークン認証（ACCESS_TOKEN設定時のみ。公開トンネルの保護用）
  registerAccessGuard(app);

  app.get("/healthz", async () => ({ status: "ok" }));

  await registerUi(app);
  await registerBrowse(app);
  await registerImage(app);
  await registerVideo(app);

  // 共有ヘッドレスブラウザをクリーンに終了する
  app.addHook("onClose", async () => {
    await closeBrowser();
  });

  return app;
}
