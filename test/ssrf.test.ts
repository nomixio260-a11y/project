import { describe, it, expect } from "vitest";
import { isBlockedIp, validateTargetUrl, SsrfError } from "../src/security/ssrf.js";

describe("isBlockedIp", () => {
  it("blocks loopback / private / reserved IPv4", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("10.0.0.5")).toBe(true);
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("172.31.255.255")).toBe(true);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true); // cloud metadata
    expect(isBlockedIp("0.0.0.0")).toBe(true);
  });

  it("allows public IPv4", () => {
    expect(isBlockedIp("1.1.1.1")).toBe(false);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("93.184.216.34")).toBe(false);
  });

  it("blocks IPv6 loopback / link-local / ULA", () => {
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fd12::1")).toBe(true);
  });

  it("blocks IPv4-mapped private IPv6", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:192.168.0.1")).toBe(true);
  });
});

describe("validateTargetUrl", () => {
  it("rejects non-http schemes", async () => {
    await expect(validateTargetUrl("file:///etc/passwd")).rejects.toThrow(SsrfError);
    await expect(validateTargetUrl("ftp://example.com")).rejects.toThrow(SsrfError);
    await expect(validateTargetUrl("gopher://example.com")).rejects.toThrow(SsrfError);
  });

  it("rejects localhost and .local", async () => {
    await expect(validateTargetUrl("http://localhost/")).rejects.toThrow(SsrfError);
    await expect(validateTargetUrl("http://foo.local/")).rejects.toThrow(SsrfError);
  });

  it("rejects literal private IPs", async () => {
    await expect(validateTargetUrl("http://127.0.0.1/")).rejects.toThrow(SsrfError);
    await expect(validateTargetUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(SsrfError);
    await expect(validateTargetUrl("http://192.168.0.1/")).rejects.toThrow(SsrfError);
  });

  it("rejects malformed URLs", async () => {
    await expect(validateTargetUrl("not a url")).rejects.toThrow(SsrfError);
  });
});
