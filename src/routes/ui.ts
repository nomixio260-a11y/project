/**
 * GET / — ブラウザシェル（public/index.html）を配信。
 * 静的アセットは @fastify/static が /public 以下で配信する。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/routes/ui.js もしくは src/routes/ui.ts から見た public ディレクトリ
const publicDir = path.resolve(__dirname, "../../public");

export async function registerUi(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/public/",
  });

  app.get("/", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").sendFile("index.html");
  });
}
