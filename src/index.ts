/** エントリポイント: サーバーを構築して起動する。 */
import { buildServer } from "./server.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  const app = await buildServer();
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
