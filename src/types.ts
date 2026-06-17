/** 共有型定義 */

export type VideoCodec = "av1" | "vp9" | "h264";

export type RenderMode = "auto" | "on" | "off";

export interface RewriteOptions {
  /** テキスト優先モード（画像・動画を省略） */
  text: boolean;
  /** デバイスのCSS表示幅(px)。画像を端末に合わせて縮小するためのヒント */
  dw?: number;
  /** デバイスピクセル比(devicePixelRatio)。Retina等で適度に高解像度を許可 */
  dpr?: number;
  /** SPAヘッドレス描画モード。リンクへ伝播してモードを維持する */
  render?: RenderMode;
  /** Opera Mini相当の「省データ最大」モード。画像強圧縮・Webフォント等を全除去 */
  mini?: boolean;
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
