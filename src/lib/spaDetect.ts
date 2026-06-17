/**
 * SPA自動検出ヒューリスティック。
 * 静的fetchしたHTMLが「JSで中身を描画するSPAの抜け殻」かどうかを安価に判定する。
 * 保守的に作り、サーバー描画済みの一般ページでは false（=描画しない）を返す。
 */

/** 空のSPAルート要素（中身がほぼ無いもの） */
const EMPTY_ROOT = /<div[^>]*\bid=["'](root|app|__next|___gatsby|__nuxt)["'][^>]*>\s*<\/div>/i;
/** noscriptでのJS要求メッセージ */
const NOSCRIPT_JS = /<noscript[^>]*>[\s\S]{0,400}?(enable|requires?|turn on)[^<]{0,40}javascript/i;

/** 表示テキストの量をざっくり見積もる（script/style/タグを除去した非空白文字数）。 */
function visibleTextLength(html: string): number {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length;
}

function scriptCount(html: string): number {
  const m = html.match(/<script\b/gi);
  return m ? m.length : 0;
}

/**
 * このHTMLをヘッドレス描画すべきか（JS駆動SPAの抜け殻か）を判定する。
 * @param html 静的fetchで得たHTML
 * @param contentType レスポンスのMIME（html系以外は対象外）
 */
export function needsRendering(html: string, contentType: string | null): boolean {
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    return false;
  }
  if (EMPTY_ROOT.test(html)) return true;
  if (NOSCRIPT_JS.test(html)) return true;

  // 可視テキストが極端に少なく、かつ scriptが多い → SPAシェルとみなす
  const textLen = visibleTextLength(html);
  if (textLen < 200 && scriptCount(html) >= 3) return true;

  return false;
}
