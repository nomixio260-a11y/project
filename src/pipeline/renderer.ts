/**
 * SPA対応のためのヘッドレスレンダラー（スナップショット方式）。
 *
 * Playwright(Chromium)でURLを開いてJSを実行し、描画後のDOMをHTML文字列として
 * 直列化して返す。返したHTMLは既存の processHtml() にそのまま渡され、
 * スクリプト除去・画像最適化・最小化が適用される（=描画は「より良い入力HTML」を
 * 作る前段にすぎない）。
 *
 * セキュリティ: ブラウザは undici / SSRFピン留めを迂回するため、context.route で
 * 全リクエストをSSRF検証し、http(s)以外と重いリソースを遮断する。
 */
import net from "node:net";
import type { Browser, BrowserContext, Route } from "playwright";
import { config } from "../config.js";
import { validateTargetUrl, isBlockedIp } from "../security/ssrf.js";

export interface RenderOptions {
  dw?: number;
  dpr?: number;
  /** 直列化HTMLのサイズ上限（バイト） */
  maxBytes: number;
}

export interface RenderResult {
  html: string;
  finalUrl: string;
}

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile DataSaverProxy/0.1";
const BLOCKED_RESOURCE_TYPES = new Set(["media", "font", "websocket", "eventsource", "image"]);

// --- 共有ブラウザ・シングルトン（lazy起動・再利用） ---
let browserPromise: Promise<Browser> | null = null;
let availability: boolean | null = null;

async function launchBrowser(): Promise<Browser> {
  // 動的importで、playwright未導入でもモジュール読み込み自体は失敗させない
  const { chromium } = await import("playwright");
  const args = [
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--mute-audio",
    "--disable-extensions",
  ];
  if (config.renderNoSandbox) args.push("--no-sandbox", "--disable-setuid-sandbox");
  return chromium.launch({ headless: true, args });
}

export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((err) => {
      // 起動失敗はキャッシュをリセットし、毎回再試行しない（availabilityで判定）
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

/** レンダラーが利用可能か（Chromium起動可否）をlazy判定しキャッシュする。 */
export async function isRendererAvailable(): Promise<boolean> {
  if (!config.enableRenderer) return false;
  if (availability !== null) return availability;
  try {
    await getBrowser();
    availability = true;
  } catch {
    availability = false;
  }
  return availability;
}

/** 共有ブラウザを閉じる（graceful shutdown / テスト用）。 */
export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close();
    } catch {
      // 既に落ちている等は無視
    }
    browserPromise = null;
    availability = null;
  }
}

// --- 同時実行数を制限する簡易セマフォ（videoTranscoderと同パターン） ---
let active = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (active < config.maxConcurrentRenders) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function releaseSlot(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * SSRFガード付きの隔離コンテキストを生成する（renderPage / ライブセッション共通）。
 * Cookie非共有・service worker遮断・ダウンロード禁止のモバイル相当コンテキスト。
 */
export async function newGuardedContext(
  browser: Browser,
  opts: { dw?: number; dpr?: number } = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: MOBILE_UA,
    viewport: { width: clamp(Math.round(opts.dw ?? 412), 320, 1280), height: 800 },
    deviceScaleFactor: clamp(opts.dpr ?? 1, 1, 3),
    serviceWorkers: "block",
    acceptDownloads: false,
    javaScriptEnabled: true,
  });
  await installGuardRoute(context);
  return context;
}

/** ブラウザの各リクエストをSSRF検証し、重いリソースを遮断するルートを設置する。 */
async function installGuardRoute(context: BrowserContext): Promise<void> {
  const hostCache = new Map<string, boolean>(); // host -> allowed
  await context.route("**", async (route: Route) => {
    const reqUrl = route.request().url();
    let u: URL;
    try {
      u = new URL(reqUrl);
    } catch {
      return route.abort();
    }
    // スキーム許可リスト（file:/chrome:/data: 等は遮断）
    if (u.protocol !== "http:" && u.protocol !== "https:") return route.abort();

    // 重いリソース（メディア/フォント/画像）は描画時にブロック（後段/imgで最適化）
    if (config.renderBlockMedia && BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
      return route.abort();
    }

    const host = u.hostname.toLowerCase();
    // 安価な同期チェック
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
      if (!config.allowPrivateHosts) return route.abort();
    }
    if (net.isIP(host) && isBlockedIp(host) && !config.allowPrivateHosts) {
      return route.abort();
    }

    // 非同期フル検証（DNS解決＋全IP検証）。ホスト単位でキャッシュ。
    const cached = hostCache.get(host);
    if (cached === false) return route.abort();
    if (cached === undefined) {
      try {
        await validateTargetUrl(reqUrl);
        hostCache.set(host, true);
      } catch {
        hostCache.set(host, false);
        return route.abort();
      }
    }
    return route.continue();
  });
}

/**
 * URLをヘッドレスChromiumで開いてJS実行後のHTMLを返す。
 * 失敗時は RenderError を投げ、呼び出し側で静的フォールバックする。
 */
export async function renderPage(url: string, opts: RenderOptions): Promise<RenderResult> {
  // 先頭URLを再検証（防御の多層化）
  await validateTargetUrl(url);

  const browser = await getBrowser();
  await acquireSlot();

  let context: BrowserContext | null = null;
  try {
    context = await newGuardedContext(browser, { dw: opts.dw, dpr: opts.dpr });

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(config.renderTimeoutMs);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.renderTimeoutMs });
    // ベストエフォートの収束待ち（超過しても描画結果は採用）
    await page
      .waitForLoadState("networkidle", { timeout: config.renderSettleMs })
      .catch(() => {});

    const html = await page.content();
    const finalUrl = page.url();

    if (Buffer.byteLength(html, "utf8") > opts.maxBytes) {
      throw new RenderError("描画結果がサイズ上限を超えました");
    }
    return { html, finalUrl };
  } catch (err) {
    if (err instanceof RenderError) throw err;
    throw new RenderError(err instanceof Error ? err.message : "レンダリングに失敗しました");
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    releaseSlot();
  }
}
