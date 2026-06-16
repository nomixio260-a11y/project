import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let mockAgent: MockAgent;

beforeAll(async () => {
  // 上流をモックし、プライベートホストを許可する（テスト用）。
  // configはimport時にenvを読むため、設定後に動的importする（ホイスティング回避）。
  process.env.ALLOW_PRIVATE_HOSTS = "1";
  const { buildServer } = await import("../src/server.js");

  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const pool = mockAgent.get("https://test.example");
  pool
    .intercept({ path: "/", method: "GET" })
    .reply(
      200,
      `<!doctype html><html><head><title>Hi</title><script>track()</script></head>
       <body><h1>Hello</h1><a href="/next">next</a><img src="/p.jpg"></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await mockAgent.close();
});

describe("GET /healthz", () => {
  it("returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /browse", () => {
  it("fetches, strips scripts, rewrites links/images", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/browse?url=" + encodeURIComponent("https://test.example/"),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const body = res.body;
    expect(body).not.toContain("track()");
    expect(body).toContain("/browse?url=https%3A%2F%2Ftest.example%2Fnext");
    expect(body).toContain("/img?url=https%3A%2F%2Ftest.example%2Fp.jpg");
    // 節約メタが埋め込まれている
    expect(body).toContain("dsp-original-bytes");
  });

  it("rejects invalid (non-http) url with 400 via schema", async () => {
    const res = await app.inject({ method: "GET", url: "/browse?url=ftp://x" });
    expect(res.statusCode).toBe(400);
  });
});
