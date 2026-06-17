/**
 * ライブ操作モード — “リモートブラウザ”の省データ版。
 *
 * 課題: スナップショット方式(renderPage)はJSを1回実行した静止HTMLを返すだけなので、
 * URLが変わらないSPA内の操作（ドロップダウン展開・「もっと見る」・検索サジェスト等）が
 * 効かない。かといってピクセル映像を流す対話的リモートブラウザは通信量が大きく、本プロキシ
 * の主目的（省データ）に反する。
 *
 * 別解: サーバー側にページを常駐させたまま、利用者のクリック/入力/スクロールだけを受け取って
 * 実ページ上で“再現”し、その都度 描画後DOMを最適化HTMLのスナップショットとして返す。
 * 転送されるのは毎回 数十KBの最適化HTMLのみ（映像なし）。動画再生はできないが、SPAの
 * 操作・ナビゲーション・検索は本物のページ上で動く。
 *
 * 仕組み:
 *  - セッション = 常駐 BrowserContext+Page（sidで識別、Cookie保持＝ログイン状態も維持）。
 *  - スナップショット直前に全要素へ data-dsp-ref を採番 → クリック対象を一意に特定可能。
 *  - 操作要求は ref を指定 → page.click(`[data-dsp-ref="ref"]`) 等で実ページに再現 → 収束待ち
 *    → 再採番してDOMを直列化 → 既存 processHtml に通して返す。
 *  - SSRF/重リソース遮断は newGuardedContext の context.route が全リクエストに適用。
 *  - 同時実行・メモリは セッション数上限 + アイドルTTL + セッション毎の直列化ロックで保護。
 */
import { randomBytes } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import { config } from "../config.js";
import { getBrowser, newGuardedContext } from "./renderer.js";
import { RenderError } from "./renderer.js";
import { validateTargetUrl } from "../security/ssrf.js";

export type LiveActionType = "goto" | "click" | "input" | "scroll" | "reload" | "back";

export interface LiveAction {
  type: LiveActionType;
  /** click/input/scroll の対象要素（直前スナップショットの data-dsp-ref） */
  ref?: string;
  /** input の入力値 */
  value?: string;
  /** scroll の縦移動量(px) / goto の対象URL */
  url?: string;
  dy?: number;
}

export interface LiveSnapshot {
  sid: string;
  html: string;
  finalUrl: string;
}

interface Session {
  id: string;
  context: BrowserContext;
  page: Page;
  lastUsed: number;
  /** セッション毎の直列化ロック（同一ページへの同時操作を防ぐ） */
  chain: Promise<unknown>;
}

const sessions = new Map<string, Session>();

/** スナップショット直前に全要素へ data-dsp-ref を採番し outerHTML を返す。 */
const ANNOTATE_AND_SERIALIZE = `(() => {
  var nodes = document.querySelectorAll('*');
  for (var i = 0; i < nodes.length; i++) nodes[i].setAttribute('data-dsp-ref', String(i));
  return '<!doctype html>' + document.documentElement.outerHTML;
})()`;

function isValidSid(sid: string): boolean {
  return /^[a-f0-9]{32}$/.test(sid);
}

/** ref は非負整数のみ許可（セレクタ・インジェクション防止） */
function refSelector(ref: string): string {
  if (!/^\d{1,9}$/.test(ref)) throw new RenderError("不正な要素参照です");
  return `[data-dsp-ref="${ref}"]`;
}

/** 期限切れセッションを掃除し、上限超過分は最古から破棄する。 */
function evictExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > config.liveSessionTtlMs) {
      sessions.delete(id);
      void s.context.close().catch(() => {});
    }
  }
}

function evictOldestIfFull(): void {
  while (sessions.size >= config.maxLiveSessions) {
    let oldestId: string | null = null;
    let oldest = Infinity;
    for (const [id, s] of sessions) {
      if (s.lastUsed < oldest) {
        oldest = s.lastUsed;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    const victim = sessions.get(oldestId)!;
    sessions.delete(oldestId);
    void victim.context.close().catch(() => {});
  }
}

/** セッション毎に処理を直列化する簡易ミューテックス。 */
function runExclusive<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  const result = s.chain.then(() => fn());
  // チェーンは成否に関わらず継続（次の操作をブロックしない）
  s.chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function createSession(opts: { dw?: number; dpr?: number }): Promise<Session> {
  evictExpired();
  evictOldestIfFull();
  const browser = await getBrowser();
  const context = await newGuardedContext(browser, opts);
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(config.renderTimeoutMs);
  page.setDefaultTimeout(config.renderTimeoutMs);
  const s: Session = {
    id: randomBytes(16).toString("hex"),
    context,
    page,
    lastUsed: Date.now(),
    chain: Promise.resolve(),
  };
  sessions.set(s.id, s);
  return s;
}

/** networkidleのベストエフォート収束待ち（超過しても結果を採用）。 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: config.renderSettleMs }).catch(() => {});
}

async function snapshot(s: Session): Promise<LiveSnapshot> {
  const html = (await s.page.evaluate(ANNOTATE_AND_SERIALIZE)) as string;
  if (Buffer.byteLength(html, "utf8") > config.maxHtmlBytes) {
    throw new RenderError("描画結果がサイズ上限を超えました");
  }
  return { sid: s.id, html, finalUrl: s.page.url() };
}

async function applyAction(s: Session, action: LiveAction): Promise<void> {
  switch (action.type) {
    case "goto": {
      if (!action.url) throw new RenderError("URLが必要です");
      await validateTargetUrl(action.url);
      await s.page.goto(action.url, {
        waitUntil: "domcontentloaded",
        timeout: config.renderTimeoutMs,
      });
      break;
    }
    case "click":
      if (!action.ref) throw new RenderError("要素参照が必要です");
      // クリックでナビゲーションが起きてもよい（guard routeがSSRF再検証）
      await s.page.click(refSelector(action.ref), { timeout: config.renderTimeoutMs });
      break;
    case "input":
      if (!action.ref) throw new RenderError("要素参照が必要です");
      await s.page.fill(refSelector(action.ref), action.value ?? "", {
        timeout: config.renderTimeoutMs,
      });
      break;
    case "scroll":
      await s.page.mouse.wheel(0, action.dy ?? 800);
      break;
    case "reload":
      await s.page.reload({ waitUntil: "domcontentloaded", timeout: config.renderTimeoutMs });
      break;
    case "back":
      await s.page.goBack({ waitUntil: "domcontentloaded", timeout: config.renderTimeoutMs });
      break;
    default:
      throw new RenderError("未知の操作です");
  }
  await settle(s.page);
}

/**
 * ライブセッションを開始（または既存sidを再利用）してURLを開き、最初のスナップショットを返す。
 */
export async function openLiveSession(
  url: string,
  opts: { dw?: number; dpr?: number; sid?: string },
): Promise<LiveSnapshot> {
  await validateTargetUrl(url);
  let s = opts.sid && isValidSid(opts.sid) ? sessions.get(opts.sid) : undefined;
  if (!s) {
    s = await createSession({ dw: opts.dw, dpr: opts.dpr });
  }
  const session = s;
  return runExclusive(session, async () => {
    session.lastUsed = Date.now();
    await applyAction(session, { type: "goto", url });
    const snap = await snapshot(session);
    session.lastUsed = Date.now();
    return snap;
  });
}

/**
 * 既存セッションに操作を再現し、新しいスナップショットを返す。
 * セッションが無い/期限切れなら SessionGoneError を投げる（呼び出し側で再オープンを促す）。
 */
export async function interactLiveSession(
  sid: string,
  action: LiveAction,
): Promise<LiveSnapshot> {
  evictExpired();
  if (!isValidSid(sid)) throw new SessionGoneError();
  const s = sessions.get(sid);
  if (!s) throw new SessionGoneError();
  return runExclusive(s, async () => {
    s.lastUsed = Date.now();
    await applyAction(s, action);
    const snap = await snapshot(s);
    s.lastUsed = Date.now();
    return snap;
  });
}

/** 操作なしで現在のDOMスナップショットだけを取り直す（操作失敗時のUI復帰用）。 */
export async function snapshotLiveSession(sid: string): Promise<LiveSnapshot> {
  if (!isValidSid(sid)) throw new SessionGoneError();
  const s = sessions.get(sid);
  if (!s) throw new SessionGoneError();
  return runExclusive(s, async () => {
    s.lastUsed = Date.now();
    return snapshot(s);
  });
}

export class SessionGoneError extends Error {
  constructor() {
    super("ライブセッションが見つかりません（期限切れ）");
    this.name = "SessionGoneError";
  }
}

/** 全ライブセッションを破棄（graceful shutdown / テスト用）。 */
export async function closeAllSessions(): Promise<void> {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((s) => s.context.close().catch(() => {})));
}

/** テスト用: 現在のセッション数。 */
export function liveSessionCount(): number {
  return sessions.size;
}
