# DataSaver Browser

Opera Mini 風の **通信量節約プロキシブラウザ**。サーバー側で対象ページを取得・加工・
強圧縮し、最小限のペイロードだけをブラウザに返すことで通信量を大幅に削減します。

## 仕組み（アーキテクチャ）

クライアント（ブラウザシェル）→ `/browse?url=...` → サーバーサイドプロキシ:

1. **SSRF検証** — http(s)のみ許可、プライベート/ループバック/クラウドメタデータIPを遮断、
   DNS解決した実IPを検証して接続をピン留め（DNSリバインド対策）
2. **取得** — undiciでリダイレクト追従（各ホップ再検証）・サイズ上限・タイムアウト付き
3. **HTML加工** — cheerioでスクリプト/広告/トラッカー除去、リンク/画像/動画をプロキシ経由に書き換え、
   インラインイベント除去、charsetをUTF-8へ正規化、CSP付与
4. **画像最適化** — `/img` で sharp により WebP へ再圧縮・縮小。
   **端末の画面幅・ピクセル比に合わせてリサイズ**（スマホには小さく、Retina/PCには適度に）
5. **動画トランスコード** — `/video` で ffmpeg により高効率コーデック（AV1/VP9/H.264）へ
   ストリーミング再エンコード。ブラウザがネイティブにデコードして元画質に近い再生
6. **最小化 + 圧縮** — HTML/CSS最小化、Brotli/gzipで配信

## SPA対応（ヘッドレスレンダリング）

YouTube/X/React・Vue製サイト等の**JS駆動SPA**は、JSを除去すると中身が表示されません。
そこで**サーバー側のヘッドレスChromium（Playwright）でJSを実行して描画**し、その結果HTMLを
既存の節約パイプライン（スクリプト除去・画像WebP化・最小化）に通します。

- **適用タイミング**: 既定`auto`（静的取得したHTMLが「空のSPAシェル」かをヒューリスティック検出して必要時のみ描画）。UIの**「SPA表示」トグル**または `render=on|off` で強制切替も可能。`render`はリンクに伝播し、ナビゲーション中もモードを維持。
- **結果は静的**: 描画後のスナップショットを配信するため、クリック操作やYouTube動画の再生はできません（コンテンツ閲覧向け）。
- **フォールバック**: Chromium未導入や描画失敗時は静的取得HTMLに自動フォールバック（`x-dsp-render-fallback: 1`）。レスポンスに `x-dsp-rendered: 1|0` を付与。
- **セキュリティ**: ブラウザは独自に通信するため、`context.route`で全リクエストをSSRF検証（`validateTargetUrl`/`isBlockedIp`再利用）、http(s)以外と重いリソース（メディア/フォント/画像）を遮断。リクエスト毎に隔離コンテキスト、Cookie非転送、service worker遮断、`renderTimeoutMs`と同時実行数上限でリソース保護。共有ブラウザ1プロセスを再利用。

> Chromiumバイナリは別途 `npm run install:chromium`（= `npx playwright install --with-deps chromium`）で導入します。未導入でも静的処理は動作します。

## ライブ操作モード（“リモートブラウザ”の省データ版）

スナップショット方式は**1回だけJSを実行した静止HTML**を返すため、URLが変わらないSPA内の操作
（ドロップダウン、「もっと見る」、検索サジェスト等）が効きません。かといって**ピクセル映像を流す
対話的リモートブラウザは通信量が大きく**、本プロキシの主目的（省データ）に反します。

そこで別方式として、**サーバー側にページを常駐させたまま、利用者のクリック/入力/スクロールだけを
受け取って実ページ上で“再現”し、その都度 最適化HTMLのスナップショットだけを返す**方式を実装しました。
転送されるのは毎回 数十KB（実測では数百バイト〜）の最適化HTMLのみで、**映像は一切流しません**。

```
クリック/入力 → /interact?sid=&type=click&ref=… → 常駐ページで再現 → 描画後DOMを再最適化 → スナップショット
```

- **使い方**: UIの**「操作モード」トグル**（または `/browse?...&live=1`）。動画再生はできませんが、SPAの
  操作・ナビゲーション・検索・ログイン後の閲覧が**本物のページ上で**動きます。
- **要素の特定**: スナップショット直前に全要素へ `data-dsp-ref` を採番。親シェルはiframe内の非リンク
  クリック/入力を捕捉し、対象の `data-dsp-ref` を付けて `/interact` へ送る（refは整数のみ＝セレクタ注入防止）。
- **状態の保持**: セッション=常駐 BrowserContext+Page。Cookie/ログイン状態やSPAの内部状態が維持される。
- **レース防止**: 親シェルは操作をFIFOキューで直列化し、iframe遷移の取りこぼしを防ぐ。入力はblur時のみ同期。
- **セキュリティ/資源**: SSRF・重リソース遮断はスナップショット方式と同じ `context.route` を共用。
  セッション数上限（`MAX_LIVE_SESSIONS`）＋アイドルTTL（`LIVE_SESSION_TTL_MS`）＋セッション毎の直列化ロックで
  メモリ・同時実行を保護。期限切れは `409` + `dsp-session-gone` メタで親シェルが自動再オープン。

## マルチデバイス対応

スマホ・タブレット・PC のいずれでも快適に使えるよう設計しています。

- **端末別の画像最適化** — シェルが画面幅(`dw`)とピクセル比(`dpr`)を `/browse` に伝え、
  画像をその端末にちょうど良いサイズへ縮小。例: 同じ写真が 360px端末で **7KB**、
  720px(Retina)で **22KB**（元 14.7MB）。`dw`/`dpr` はページ内リンクにも伝播し、
  プロキシ経由のナビゲーション全体で端末最適化を維持します。
- **レスポンシブUI** — メディアクエリでスマホ時はアドレスバーを全幅化、
  タッチターゲットは40px以上、ノッチ端末の `safe-area-inset` とダークモードに対応。
- **ブラウザ操作** — 戻る / 進む / 再読み込み（独自履歴）、ローディング表示、
  アドレスバー自動同期。
- **PWA** — `manifest.webmanifest` によりホーム画面に追加してアプリのように起動可能
  （`display: standalone`）。

## 通信量節約の実測例

| 対象 | 元 | 配信後 | 削減 |
| --- | --- | --- | --- |
| Wikipedia「HTTP」記事 (HTML) | 559KB | 68KB (Brotli) | **88%** |
| Google ロゴ PNG | 13.5KB | 6.0KB (WebP) | 55% |
| httpbin JPEG | 35.6KB | 8.7KB (WebP) | 76% |
| サンプル動画 MP4 | 788KB | 282KB (AV1) / 372KB (VP9) | 53〜64% |

## 動画について

低ビットレート再エンコードからの**厳密なロスレス復元は情報理論上不可能**です。本実装は
「同じ見た目をより少ないデータで送り、ブラウザがデコードして元画質に近い再生を行う」
高効率コーデック方式を採用しています。クライアント（`public/app.js`）が
`canPlayType` で対応コーデックを判定し AV1 → VP9 → H.264 の順に最良を選択します。
YouTube等の埋め込みiframeは再エンコード不可のため click-to-play プレースホルダに置換します。

## エンドポイント

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/` | ブラウザシェル（戻る/進む/再読込 + アドレスバー + テキスト優先トグル） |
| GET | `/browse?url=&text=0\|1&dw=&dpr=&render=auto\|on\|off&live=0\|1` | ページ取得・加工・圧縮して返す（`render`はSPA描画、`live`はライブ操作モード） |
| GET | `/interact?sid=&type=click\|input\|scroll\|reload\|back&ref=&value=&dy=` | ライブセッションへ操作を再現し新スナップショットを返す |
| GET | `/img?url=&w=&q=` | 画像を WebP へ最適化（`w`は端末幅に応じて決定） |
| GET | `/video?url=&codec=av1\|vp9\|h264` | 動画を高効率コーデックへ再エンコード |
| GET | `/healthz` | 死活監視 |

## セットアップ

```bash
# 前提: Node.js >= 20, ffmpeg（AV1/VP9エンコーダ込み）
npm install
npm run dev          # 開発（tsx watch）
# or
npm run build && npm start
```

ブラウザで `http://localhost:3000/` を開き、アドレスバーにURLを入力します。

## GitHub Actions で公開（Cloudflare Tunnel）

GitHub Actions 上でビルド・起動し、**Cloudflare のクイックトンネル**
（アカウント不要・無料・一時的な `https://<ランダム>.trycloudflare.com`）で
インターネットに公開できます。

1. リポジトリの **Actions** タブ → **Public Tunnel** → **Run workflow**
2. 公開時間（分）と「アクセストークンで保護」を選んで実行
3. 実行ログ末尾の **Summary** に公開URLが表示されます
   （保護オン時は `https://<ランダム>.trycloudflare.com/?token=...`）
4. そのURLをスマホ／PCのブラウザで開く

ワークフロー: `.github/workflows/tunnel.yml`（公開）/ `.github/workflows/ci.yml`
（push毎のビルド・型チェック・テスト）。

> **セキュリティ**: 公開トンネルはオープンプロキシ濫用の対象になり得ます。既定では
> ランダムな `ACCESS_TOKEN` を発行し、`?token=...` 付きURLから開いた利用者だけが
> 使えるよう Cookie で保護します（保護をオフにすると誰でも使えるので短時間のみ推奨）。
> 安定した独自ドメインが必要な場合は、Cloudflare の名前付きトンネル（トークンを
> リポジトリ Secret に設定）に差し替えてください。

### 環境変数（主なもの）

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `PORT` | 3000 | リッスンポート |
| `HOST` | 0.0.0.0 | バインドアドレス |
| `ACCESS_TOKEN` | (未設定) | 設定すると認証ゲートが有効。`/?token=...`でCookie発行した利用者のみ許可（公開時の保護用） |
| `ENABLE_RENDERER` | 1 | `0`でSPAヘッドレス描画を無効化（常に静的処理） |
| `MAX_CONCURRENT_RENDERS` | 2 | 同時レンダリング数の上限（メモリ保護） |
| `RENDER_TIMEOUT_MS` | 15000 | レンダリング全体のタイムアウト |
| `RENDER_BLOCK_MEDIA` | 1 | 描画時にメディア/フォント/画像を遮断して帯域節約 |
| `RENDER_NO_SANDBOX` | (未設定) | `1`でChromiumを`--no-sandbox`起動（コンテナ/root環境向け） |
| `ENABLE_LIVE_SESSIONS` | 1 | `0`でライブ操作モードを無効化 |
| `MAX_LIVE_SESSIONS` | 4 | 同時保持する常駐セッション（ページ）の最大数 |
| `LIVE_SESSION_TTL_MS` | 300000 | ライブセッションのアイドルTTL（超過で常駐ページ破棄） |
| `FETCH_TIMEOUT_MS` | 10000 | 上流fetchタイムアウト |
| `MAX_HTML_BYTES` | 10MB | HTMLサイズ上限 |
| `MAX_VIDEO_BYTES` | 200MB | 動画ソースサイズ上限 |
| `MAX_CONCURRENT_TRANSCODES` | 2 | 同時動画変換数（CPU保護） |
| `IMAGE_DEFAULT_WIDTH` / `IMAGE_DEFAULT_QUALITY` | 800 / 60 | 画像最適化の既定 |
| `RATE_LIMIT_MAX` | 120 | 1分あたりリクエスト上限 |
| `ALLOW_PRIVATE_HOSTS` | (未設定) | `1` でSSRF検証を無効化（**開発・テスト専用**） |

## テスト

```bash
npm test
```

- `ssrf` — プライベート/予約IP・非httpスキームの遮断
- `urlRewriter` — 相対→絶対解決、srcset、フラグ伝播
- `htmlProcessor` — スクリプト/広告除去、リンク/画像/動画書き換え、テキストモード
- `imageOptimizer` — WebP変換・リサイズ・SVGパススルー
- `videoTranscoder` — AV1/VP9/H.264 への再エンコード（ffmpeg検出時のみ）
- `accessGuard` — アクセストークン認証（401・Cookie発行・Cookie認証）
- `spaDetect` — SPAシェル自動検出ヒューリスティック
- `renderer` — ヘッドレスChromiumでのJS実行・描画（Chromium導入時のみ実行、未導入時は自動スキップ）
- `liveSession` — ライブ操作モードのクリック/入力再現と状態保持（Chromium導入時のみ実行）
- `browse.e2e` — MockAgentで上流をモックした統合テスト（`render=off`含む）

## セキュリティ上の注意

これはオープンプロキシになり得ます。公開運用する場合は認証・許可リスト・
レート制限の強化を行ってください。SSRF対策・CSP・Cookie非転送・ヘッダ衛生は
実装済みですが、信頼境界を理解した上で運用してください。
