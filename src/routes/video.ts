/**
 * GET /video?url=<abs>&codec=<av1|vp9|h264>
 * 動画を取得し、高効率コーデックへ再エンコードしてストリーミング配信する。
 * クライアントが対応コーデックを判定して codec= を指定する。
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { safeFetch } from "../pipeline/fetcher.js";
import { transcodeVideo } from "../pipeline/videoTranscoder.js";
import { isVideo } from "../lib/contentType.js";
import type { VideoCodec } from "../types.js";

interface VideoQuery {
  url: string;
  codec?: VideoCodec;
}

const videoSchema = {
  querystring: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", pattern: "^https?://" },
      codec: { type: "string", enum: ["av1", "vp9", "h264"] },
    },
  },
};

export async function registerVideo(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: VideoQuery }>("/video", { schema: videoSchema }, async (req, reply) => {
    const { url } = req.query;
    const codec: VideoCodec = req.query.codec ?? "h264";

    let result;
    try {
      result = await safeFetch(url, {
        maxBytes: config.maxVideoBytes,
        accept: "video/*,*/*;q=0.8",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "取得に失敗しました";
      return reply.code(502).send(message);
    }

    if (result.contentType && !isVideo(result.contentType)) {
      return reply.code(415).send("動画ではありません");
    }

    try {
      const { stream, contentType } = await transcodeVideo(result.body, codec);
      reply
        .header("content-type", contentType)
        .header("cache-control", "public, max-age=86400")
        .header("x-content-type-options", "nosniff");
      // ストリームをそのまま返す（変換完了を待たずに送出開始）
      return reply.send(stream);
    } catch {
      return reply.code(502).send("動画の変換に失敗しました");
    }
  });
}
