/**
 * GET /img?url=<abs>&w=<int>&q=<int>
 * 画像を取得し sharp で リサイズ + WebP変換して返す。強キャッシュ。
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { safeFetch } from "../pipeline/fetcher.js";
import { optimizeImage } from "../pipeline/imageOptimizer.js";
import { isImage } from "../lib/contentType.js";

interface ImageQuery {
  url: string;
  w?: number;
  q?: number;
}

const imageSchema = {
  querystring: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", pattern: "^https?://" },
      w: { type: "integer", minimum: 16, maximum: 1600 },
      q: { type: "integer", minimum: 10, maximum: 90 },
    },
  },
};

export async function registerImage(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ImageQuery }>("/img", { schema: imageSchema }, async (req, reply) => {
    const { url } = req.query;
    const width = req.query.w ?? config.imageDefaultWidth;
    const quality = req.query.q ?? config.imageDefaultQuality;

    try {
      const result = await safeFetch(url, {
        maxBytes: config.maxImageBytes,
        accept: "image/avif,image/webp,image/*,*/*;q=0.8",
      });

      if (result.contentType && !isImage(result.contentType)) {
        return reply.code(415).send("画像ではありません");
      }

      const optimized = await optimizeImage(result.body, { width, quality }, result.contentType);

      reply
        .header("content-type", optimized.contentType)
        .header("cache-control", "public, max-age=604800, immutable")
        .header("x-content-type-options", "nosniff");
      return reply.send(optimized.data);
    } catch (err) {
      req.log.error({ err, url }, "image optimization failed");
      return reply.code(502).send("画像の最適化に失敗しました");
    }
  });
}
