/**
 * SSRF対策（最重要）。
 * 上流へ接続する全URLはここを通す。プライベート/ループバック/予約レンジ、
 * 非httpスキーム、クラウドメタデータIPを遮断する。DNSリバインド対策として
 * 名前解決した実IPを検証し、接続をそのIPにピン留めする（dispatcherForUrl）。
 */
import dns from "node:dns/promises";
import net from "node:net";
import { Agent } from "undici";
import { config } from "../config.js";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/** 与えられたIP（v4/v6）がプライベート/予約/ループバック等かどうか */
export function isBlockedIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) return isBlockedIpv4(ip);
  if (type === 6) return isBlockedIpv6(ip);
  // パースできないものは安全側で遮断
  return true;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // ループバック
  if (a === 169 && b === 254) return true; // link-local（クラウドメタデータ169.254.169.254含む）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // マルチキャスト/予約
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // ループバック/未指定
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
  // IPv4-mapped (::ffff:a.b.c.d) はマップ先で判定
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && mapped[1]) return isBlockedIpv4(mapped[1]);
  return false;
}

export interface ValidatedTarget {
  url: URL;
  /** ピン留め対象の検証済みIP（複数あれば全て検証済み） */
  addresses: string[];
}

/**
 * URL文字列を検証し、http(s)のみ許可、ホスト名を解決して全IPを検証する。
 * 失敗時は SsrfError を投げる。
 */
export async function validateTargetUrl(rawUrl: string): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("URLの形式が不正です");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`許可されないスキーム: ${url.protocol}`);
  }

  const hostname = url.hostname;
  if (!hostname) throw new SsrfError("ホスト名がありません");

  if (config.allowPrivateHosts) {
    // 開発・テスト用バイパス
    return { url, addresses: [] };
  }

  const lowerHost = hostname.toLowerCase();
  if (lowerHost === "localhost" || lowerHost.endsWith(".localhost") || lowerHost.endsWith(".local")) {
    throw new SsrfError("ローカルホストへのアクセスは禁止されています");
  }

  // ホストがリテラルIPならそのまま検証
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new SsrfError("プライベート/予約IPへのアクセスは禁止されています");
    return { url, addresses: [hostname] };
  }

  // 名前解決して全アドレスを検証
  let resolved: { address: string }[];
  try {
    resolved = await dns.lookup(hostname, { all: true });
  } catch {
    throw new SsrfError("名前解決に失敗しました");
  }
  if (resolved.length === 0) throw new SsrfError("名前解決の結果が空です");

  for (const { address } of resolved) {
    if (isBlockedIp(address)) {
      throw new SsrfError("解決先がプライベート/予約IPのため遮断しました");
    }
  }

  return { url, addresses: resolved.map((r) => r.address) };
}

/**
 * 検証済みIPに接続をピン留めするundici Agentを返す（DNSリバインド対策）。
 * lookupを差し替え、再解決ではなく検証済みアドレスのみ使わせる。
 */
export function dispatcherForTarget(target: ValidatedTarget): Agent | undefined {
  if (config.allowPrivateHosts || target.addresses.length === 0) return undefined;
  const pinned = target.addresses;
  return new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        const family = net.isIP(pinned[0]!);
        // 検証済みIPを返す（hostnameの再解決を行わない）
        callback(null, [{ address: pinned[0]!, family: family === 6 ? 6 : 4 }]);
      },
    },
  });
}
