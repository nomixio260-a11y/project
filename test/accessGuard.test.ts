import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
const TOKEN = "s3cret-test-token";

beforeAll(async () => {
  // configはimport時にenvを読むため、設定後に動的importする
  process.env.ACCESS_TOKEN = TOKEN;
  const { buildServer } = await import("../src/server.js");
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("access guard (ACCESS_TOKEN set)", () => {
  it("always allows /healthz without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("blocks the shell without a token (401)", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(401);
  });

  it("blocks proxy endpoints without a token (401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/browse?url=" + encodeURIComponent("https://example.com/"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("issues a cookie when /?token=... matches", async () => {
    const res = await app.inject({ method: "GET", url: "/?token=" + TOKEN });
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain("dsp_token=");
    expect(setCookie).toContain("HttpOnly");
  });

  it("rejects a wrong token on the shell", async () => {
    const res = await app.inject({ method: "GET", url: "/?token=wrong" });
    expect(res.statusCode).toBe(401);
  });

  it("allows requests carrying a valid cookie", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { cookie: `dsp_token=${encodeURIComponent(TOKEN)}` },
    });
    expect(res.statusCode).toBe(200);
    // 保護対象のシェルもCookieで通る
    const shell = await app.inject({
      method: "GET",
      url: "/",
      headers: { cookie: `dsp_token=${encodeURIComponent(TOKEN)}` },
    });
    expect(shell.statusCode).toBe(200);
  });
});
