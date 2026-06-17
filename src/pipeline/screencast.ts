/**
 * 映像ストリーミング方式のリモートブラウザ。
 *
 * サーバー上の常駐ページを CDP スクリーンキャスト（Page.startScreencast）で
 * JPEGフレームの映像として配信し、クライアントからのマウス/キーボード/スクロール入力を
 * CDP Input / Playwright で実ページへ送り返す双方向リモートブラウザ。
 *
 * スナップショット方式と違い「画面そのもの」を映像で流すため、動画再生を含む完全な操作が
 * できる（通信量は大きい）。SSRF・重リソース遮断は描画と同じ newGuardedContext の
 * context.route を共用。同時ストリーム数はセマフォで制限する。
 */
import type { BrowserContext, CDPSession, Page } from "playwright";
import { config } from "../config.js";
import { getBrowser, newGuardedContext, clamp } from "./renderer.js";
import { validateTargetUrl } from "../security/ssrf.js";

export interface StreamFrame {
  /** JPEGのbase64データ（data URIのペイロード） */
  data: string;
}

export type InputMessage =
  | { type: "mousemove"; x: number; y: number; buttons?: number }
  | { type: "mousedown"; x: number; y: number; button?: ButtonName }
  | { type: "mouseup"; x: number; y: number; button?: ButtonName }
  | { type: "wheel"; x: number; y: number; deltaX?: number; deltaY?: number }
  | { type: "key"; key: string }
  | { type: "text"; text: string }
  | { type: "navigate"; url: string };

type ButtonName = "left" | "right" | "middle";

export interface StreamOptions {
  url: string;
  dw?: number;
  dpr?: number;
}

// --- 同時ストリーム数の制限 ---
let active = 0;

export function streamSlotsAvailable(): boolean {
  return active < config.maxLiveSessions;
}

/**
 * 1本のリモートブラウザ・ストリーム。start()で開始し、onFrameで映像、input()で操作、
 * close()で破棄する。1接続=1インスタンス。
 */
export class BrowserStream {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private closed = false;
  private frameCb: ((frame: StreamFrame) => void) | null = null;
  readonly viewport: { width: number; height: number };

  constructor(opts: StreamOptions) {
    this.viewport = {
      width: clamp(Math.round(opts.dw ?? 412), 320, config.streamMaxWidth),
      height: clamp(Math.round((opts.dw ?? 412) * 1.6), 320, config.streamMaxHeight),
    };
    this.dpr = clamp(opts.dpr ?? 1, 1, 3);
    this.startUrl = opts.url;
  }
  private dpr: number;
  private startUrl: string;

  onFrame(cb: (frame: StreamFrame) => void): void {
    this.frameCb = cb;
  }

  /** ストリームを開始（URL検証→ページ生成→goto→スクリーンキャスト開始）。 */
  async start(): Promise<void> {
    await validateTargetUrl(this.startUrl);
    active++;
    const browser = await getBrowser();
    this.context = await newGuardedContext(browser, { dw: this.viewport.width, dpr: this.dpr });
    this.page = await this.context.newPage();
    await this.page.setViewportSize(this.viewport);
    this.page.setDefaultNavigationTimeout(config.renderTimeoutMs);

    this.cdp = await this.context.newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", (params: { data: string; sessionId: number }) => {
      if (this.frameCb && !this.closed) this.frameCb({ data: params.data });
      // ackしないと次のフレームが来ない
      this.cdp?.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    });

    // ナビゲーション前にスクリーンキャストを開始しておくと、ロード時の描画が
    // そのままフレームとして流れる（ヘッドレスでは静止画面だとフレームが出ないため）。
    await this.page.bringToFront().catch(() => {});
    await this.startScreencast();
    await this.page
      .goto(this.startUrl, { waitUntil: "domcontentloaded", timeout: config.renderTimeoutMs })
      .catch(() => {});
    await this.nudgeRepaint();
  }

  /** 静止ページでも確実に最初のフレームを得るための軽い再描画トリガ。 */
  private async nudgeRepaint(): Promise<void> {
    if (!this.page) return;
    // レイアウトに影響しない微小変化で compositor に1フレーム出させる。
    // 関数ではなく文字列で渡す（評価はブラウザ側／tscのDOM型に依存させない）。
    await this.page
      .evaluate(
        "(() => { var h = document.documentElement; var p = h.style.transform;" +
          " h.style.transform = 'translateZ(0)'; void h.offsetHeight; h.style.transform = p; })()",
      )
      .catch(() => {});
  }

  private async startScreencast(): Promise<void> {
    if (!this.cdp) return;
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: clamp(config.streamQuality, 1, 100),
      maxWidth: Math.round(this.viewport.width * this.dpr),
      maxHeight: Math.round(this.viewport.height * this.dpr),
      everyNthFrame: Math.max(1, config.streamEveryNthFrame),
    });
  }

  /** クライアントからの入力を実ページへ反映する。 */
  async input(msg: InputMessage): Promise<void> {
    if (this.closed || !this.page || !this.cdp) return;
    const page = this.page;
    switch (msg.type) {
      case "mousemove":
        await this.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: msg.x,
          y: msg.y,
          buttons: msg.buttons ?? 0,
        });
        break;
      case "mousedown":
        await this.cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: msg.x,
          y: msg.y,
          button: msg.button ?? "left",
          buttons: buttonsMask(msg.button),
          clickCount: 1,
        });
        break;
      case "mouseup":
        await this.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: msg.x,
          y: msg.y,
          button: msg.button ?? "left",
          buttons: 0,
          clickCount: 1,
        });
        break;
      case "wheel":
        await this.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: msg.x,
          y: msg.y,
          deltaX: msg.deltaX ?? 0,
          deltaY: msg.deltaY ?? 0,
        });
        break;
      case "key":
        // 特殊キー（Enter/Backspace/Arrow等）。修飾キーは押下のみ送る
        await page.keyboard.press(sanitizeKey(msg.key)).catch(() => {});
        break;
      case "text":
        // 文字入力はIMEに依らずそのまま挿入
        await page.keyboard.insertText(msg.text.slice(0, 256)).catch(() => {});
        break;
      case "navigate":
        await validateTargetUrl(msg.url);
        await page
          .goto(msg.url, { waitUntil: "domcontentloaded", timeout: config.renderTimeoutMs })
          .catch(() => {});
        await this.startScreencast().catch(() => {});
        break;
    }
  }

  /** 現在のページURL（アドレスバー同期用）。 */
  currentUrl(): string {
    try {
      return this.page?.url() ?? this.startUrl;
    } catch {
      return this.startUrl;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.frameCb = null;
    try {
      await this.cdp?.send("Page.stopScreencast").catch(() => {});
    } finally {
      await this.context?.close().catch(() => {});
      this.context = null;
      this.page = null;
      this.cdp = null;
      active = Math.max(0, active - 1);
    }
  }
}

function buttonsMask(button?: ButtonName): number {
  switch (button) {
    case "right":
      return 2;
    case "middle":
      return 4;
    default:
      return 1;
  }
}

/** Playwrightが受け付けるキー名のみ許可（不正値での例外/注入を防ぐ）。 */
function sanitizeKey(key: string): string {
  if (/^[\w]{1,20}$/.test(key) || /^(Arrow(Up|Down|Left|Right)|Page(Up|Down)|Home|End)$/.test(key)) {
    return key;
  }
  // 単一の表示文字はそのまま
  if ([...key].length === 1) return key;
  return "Unidentified";
}
