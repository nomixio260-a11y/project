/**
 * 広告・トラッカー除去のためのセレクタ/ホストのブロックリスト。
 * 完全網羅は目的ではなく、代表的なものを軽量に除去する。
 */

/** 除去対象のCSSセレクタ（cheerioで .remove()） */
export const AD_SELECTORS: string[] = [
  // スクリプト・noscript・トラッキング系
  "script",
  "noscript",
  // 広告コンテナの典型的なクラス/id（部分一致）
  "[class*='ad-']",
  "[class*='ads-']",
  "[class*='advert']",
  "[id*='google_ads']",
  "[id*='-ad-']",
  "ins.adsbygoogle",
  "iframe[src*='doubleclick']",
  "iframe[src*='googlesyndication']",
  "iframe[src*='ads']",
  // トラッキングピクセル
  "img[width='1'][height='1']",
  // ソーシャル/解析ウィジェット
  "[class*='tracking']",
  "[class*='analytics']",
];

/** src/hrefがこれらのホストを含む要素は除去 */
export const BLOCKED_HOSTS: string[] = [
  "doubleclick.net",
  "googlesyndication.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "scorecardresearch.com",
  "adservice.google.com",
  "amazon-adsystem.com",
  "facebook.net",
  "connect.facebook.net",
  "hotjar.com",
  "segment.com",
  "criteo.com",
  "taboola.com",
  "outbrain.com",
];

export function isBlockedHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}
