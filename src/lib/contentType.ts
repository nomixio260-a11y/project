/** Content-Type と charset の解析ヘルパー */

export interface ParsedContentType {
  /** "text/html" のような小文字MIME（パラメータ除去済み） */
  mime: string;
  /** charset（小文字）。無ければ null */
  charset: string | null;
}

export function parseContentType(header: string | null | undefined): ParsedContentType {
  if (!header) return { mime: "", charset: null };
  const parts = header.split(";");
  const mime = (parts[0] ?? "").trim().toLowerCase();
  let charset: string | null = null;
  for (const part of parts.slice(1)) {
    const [k, v] = part.split("=");
    if (k && v && k.trim().toLowerCase() === "charset") {
      charset = v.trim().toLowerCase().replace(/^["']|["']$/g, "");
    }
  }
  return { mime, charset };
}

export function isHtml(mime: string): boolean {
  return mime === "text/html" || mime === "application/xhtml+xml";
}

export function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

export function isVideo(mime: string): boolean {
  return mime.startsWith("video/");
}
