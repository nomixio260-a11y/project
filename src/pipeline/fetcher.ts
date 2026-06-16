/**
 * 安全な上流fetch。SSRF検証・リダイレクト追従（各ホップ再検証）・サイズ上限・
 * タイムアウトを一括で適用する。本文はサイズ上限を超えた時点で中断する。
 */
import { request } from "undici";
import { config } from "../config.js";
import {
  validateTargetUrl,
  dispatcherForTarget,
  SsrfError,
} from "../security/ssrf.js";
import { parseContentType } from "../lib/contentType.js";
import type { FetchResult } from "../types.js";

const DEFAULT_HEADERS = {
  // 一般的なブラウザを装い、圧縮済みレスポンスを受け取る
  "user-agent":
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile DataSaverProxy/0.1",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en,ja;q=0.9",
};

export interface SafeFetchOptions {
  /** 本文サイズの上限（バイト） */
  maxBytes: number;
  /** Acceptヘッダの上書き（画像・動画用） */
  accept?: string;
}

/**
 * リダイレクトを自前で追従し、各ホップでSSRF検証を行う安全なfetch。
 * undiciの自動リダイレクトは使わず（内部ホストへの跳躍を防ぐため）手動で辿る。
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<FetchResult> {
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= config.maxRedirections; hop++) {
    const target = await validateTargetUrl(currentUrl);
    const dispatcher = dispatcherForTarget(target);

    const headers: Record<string, string> = { ...DEFAULT_HEADERS };
    if (opts.accept) headers.accept = opts.accept;
    // HostヘッダはundiciがURLから自動付与する（手動指定は重複し一部サーバーで400になる）。
    // ピン留めはTCP接続先IPのみ変更し、SNI/HostはURLのホスト名が使われる。

    const res = await request(target.url.toString(), {
      method: "GET",
      headers,
      dispatcher,
      headersTimeout: config.fetchTimeoutMs,
      bodyTimeout: config.fetchTimeoutMs,
    });
    // 破棄時の UND_ERR_ABORTED 等が unhandled error にならないよう常に捕捉
    res.body.on("error", () => {});

    // リダイレクト処理
    if (res.statusCode >= 300 && res.statusCode < 400) {
      const location = res.headers["location"];
      await drain(res.body);
      if (!location || typeof location !== "string") {
        throw new Error(`リダイレクト先が不明です (status ${res.statusCode})`);
      }
      currentUrl = new URL(location, target.url).toString();
      continue;
    }

    if (res.statusCode >= 400) {
      await drain(res.body);
      throw new Error(`上流がエラーを返しました: ${res.statusCode}`);
    }

    const rawCt = res.headers["content-type"];
    const ctHeader = Array.isArray(rawCt) ? rawCt[0] : rawCt;
    const { mime, charset } = parseContentType(ctHeader);

    const body = await readCapped(res.body, opts.maxBytes);

    return {
      finalUrl: target.url.toString(),
      status: res.statusCode,
      contentType: mime || null,
      charset,
      body,
    };
  }

  throw new SsrfError("リダイレクト回数の上限を超えました");
}

/** 本文を破棄するために安全にドレインする（エラーは無視） */
async function drain(stream: NodeJS.ReadableStream): Promise<void> {
  try {
    const s = stream as NodeJS.ReadableStream & { dump?: () => Promise<void> };
    if (typeof s.dump === "function") {
      await s.dump();
    } else {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    }
  } catch {
    // 破棄時のエラーは無視
  }
}

/** ストリームをサイズ上限付きで読み切る。超過したら中断して例外。 */
async function readCapped(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      throw new Error(`レスポンスがサイズ上限(${maxBytes}バイト)を超えました`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}
