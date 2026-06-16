/** スタックトレースを出さない親切なエラーページ */
export function renderErrorPage(url: string, message: string): string {
  const safeUrl = escapeHtml(url);
  const safeMsg = escapeHtml(message);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>読み込みエラー</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem;color:#333}h1{font-size:1.3rem}.url{word-break:break-all;color:#666;font-size:.9rem}.msg{background:#fff3f3;border:1px solid #f0c0c0;padding:.75rem 1rem;border-radius:6px}</style></head><body><h1>ページを読み込めませんでした</h1><p class="url">${safeUrl}</p><p class="msg">${safeMsg}</p><p><a href="/">← ホームに戻る</a></p></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
