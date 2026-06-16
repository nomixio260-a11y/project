/** 共有型定義 */

export type VideoCodec = "av1" | "vp9" | "h264";

export interface RewriteOptions {
  /** テキスト優先モード（画像・動画を省略） */
  text: boolean;
}

export interface FetchResult {
  /** リダイレクト後の最終URL（URL書き換えの基準） */
  finalUrl: string;
  status: number;
  contentType: string | null;
  /** charsetを含む生のcontent-typeから抽出した文字コード（小文字） */
  charset: string | null;
  body: Buffer;
}

/** HTML加工の結果と、節約効果のメタ情報 */
export interface ProcessedHtml {
  html: string;
  originalBytes: number;
  processedBytes: number;
}
