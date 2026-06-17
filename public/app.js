/**
 * 親シェルのスクリプト。プロキシ済みページ（同一オリジンのiframe）はJSを
 * 除去済みなので、対話的処理は全てここ（親）から行う:
 *   - URL移動 / テキストモード切替 / 戻る・進む・再読み込み（独自履歴）
 *   - デバイス幅・DPRを /browse に伝え、画像を端末サイズに最適化
 *   - iframe内リンク・GETフォームのプロキシ経由ナビ補助
 *   - 動画コーデックのクライアント能力判定 → /video の codec 差し替え
 *   - 埋め込み動画の click-to-play 展開
 *   - ローディング表示 / 節約メーター表示
 */
(function () {
  "use strict";

  var form = document.getElementById("nav");
  var address = document.getElementById("address");
  var textmode = document.getElementById("textmode");
  var spamode = document.getElementById("spamode");
  var livemode = document.getElementById("livemode");
  var iframe = document.getElementById("page");
  var welcome = document.getElementById("welcome");
  var savingsEl = document.getElementById("savings");
  var backBtn = document.getElementById("back");
  var fwdBtn = document.getElementById("forward");
  var reloadBtn = document.getElementById("reload");
  var progress = document.getElementById("progress");

  /** クライアントが再生可能な最良コーデックを判定（AV1 → VP9 → H.264） */
  function bestCodec() {
    var v = document.createElement("video");
    if (v.canPlayType('video/webm; codecs="av01.0.05M.08"')) return "av1";
    if (v.canPlayType('video/webm; codecs="vp9"')) return "vp9";
    return "h264";
  }
  var CODEC = bestCodec();

  /** この端末の画像最適化ヒント（CSS表示幅とピクセル比） */
  function deviceHints() {
    var dw = Math.round(document.documentElement.clientWidth || window.innerWidth || 0);
    var dpr = window.devicePixelRatio || 1;
    return { dw: dw, dpr: Math.round(dpr * 100) / 100 };
  }

  /** 元URL+モードから /browse パスを組み立てる（デバイスヒントを付与） */
  function buildBrowseUrl(targetUrl) {
    if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "https://" + targetUrl;
    var d = deviceHints();
    var u = "/browse?url=" + encodeURIComponent(targetUrl);
    if (textmode.checked) u += "&text=1";
    if (d.dw) u += "&dw=" + d.dw + "&dpr=" + d.dpr;
    if (spamode.checked) u += "&render=on";
    return u;
  }

  // ===== 操作モード（映像ストリーミング＝リモートブラウザ）の状態 =====
  var streamUrl = null; // ストリーミング中の実URL

  // サーバーがURL変化（SPA内遷移含む）を通知 → アドレスバー同期
  if (window.DSPStream) {
    window.DSPStream.onUrl(function (u) {
      streamUrl = u;
      address.value = u;
    });
  }

  /** 操作モードでURLを開く（既存ストリームがあれば同一セッションのまま遷移） */
  function streamOpen(targetUrl) {
    if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "https://" + targetUrl;
    welcome.style.display = "none";
    iframe.style.display = "none";
    streamUrl = targetUrl;
    address.value = targetUrl;
    var d = deviceHints();
    if (window.DSPStream.isActive()) {
      window.DSPStream.navigate(targetUrl);
    } else {
      window.DSPStream.open(targetUrl, { dw: d.dw, dpr: d.dpr });
    }
  }

  // ===== 独自履歴（戻る・進む） =====
  var stack = []; // /browse パスの配列
  var pos = -1; // 現在位置
  var suppressPush = false; // 戻る/進む/再読込による遷移はpushしない

  function load(browsePath) {
    welcome.style.display = "none";
    startLoading();
    iframe.src = browsePath;
  }

  function navigate(targetUrl) {
    if (!targetUrl) return;
    // 操作モードは映像ストリーミング、それ以外はプロキシ済みiframe表示
    if (livemode.checked) {
      streamOpen(targetUrl);
      return;
    }
    load(buildBrowseUrl(targetUrl));
  }

  function updateNavButtons() {
    backBtn.disabled = pos <= 0;
    fwdBtn.disabled = pos >= stack.length - 1;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    navigate(address.value.trim());
  });

  backBtn.addEventListener("click", function () {
    if (pos > 0) {
      pos--;
      suppressPush = true;
      load(stack[pos]);
      updateNavButtons();
    }
  });

  fwdBtn.addEventListener("click", function () {
    if (pos < stack.length - 1) {
      pos++;
      suppressPush = true;
      load(stack[pos]);
      updateNavButtons();
    }
  });

  reloadBtn.addEventListener("click", function () {
    if (livemode.checked && window.DSPStream.isActive() && streamUrl) {
      window.DSPStream.navigate(streamUrl);
      return;
    }
    if (pos >= 0) {
      suppressPush = true;
      load(stack[pos]);
    }
  });

  textmode.addEventListener("change", function () {
    var cur = currentProxiedUrl();
    if (cur) navigate(cur);
  });

  spamode.addEventListener("change", function () {
    var cur = currentProxiedUrl();
    if (cur) navigate(cur);
  });

  livemode.addEventListener("change", function () {
    if (livemode.checked) {
      // 操作モードON: 現在のページを映像ストリーミングで開き直す
      var cur = currentProxiedUrl() || streamUrl || address.value.trim();
      if (cur) streamOpen(cur);
    } else {
      // 操作モードOFF: ストリームを閉じ、通常のプロキシ表示へ戻す
      var u = streamUrl;
      window.DSPStream.close();
      iframe.style.display = "";
      if (u) navigate(u);
    }
  });

  /** iframeの現在URL(/browse?url=...)から元URLを取り出す */
  function currentProxiedUrl() {
    try {
      var loc = iframe.contentWindow.location.href;
      var m = loc.match(/[?&]url=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) {
      return null;
    }
  }

  /** iframeの現在パス(/browse?...)を取得（履歴比較用） */
  function currentBrowsePath() {
    try {
      var l = iframe.contentWindow.location;
      return l.pathname + l.search;
    } catch (e) {
      return null;
    }
  }

  // ===== ローディング表示 =====
  function startLoading() {
    progress.hidden = false;
  }
  function stopLoading() {
    progress.hidden = true;
  }

  iframe.addEventListener("load", function () {
    stopLoading();

    var doc;
    try {
      doc = iframe.contentDocument;
    } catch (e) {
      return; // クロスオリジン（パススルー等）はスキップ
    }
    if (!doc) return;

    // 履歴へ反映（戻る/進む/再読込以外の新規遷移のみ追加）
    var path = currentBrowsePath();
    if (path && path.indexOf("/browse") === 0) {
      if (suppressPush) {
        suppressPush = false;
      } else if (stack[pos] !== path) {
        stack = stack.slice(0, pos + 1);
        stack.push(path);
        pos = stack.length - 1;
      }
    }
    updateNavButtons();

    // アドレスバーを実URLに同期
    var cur = currentProxiedUrl();
    if (cur) address.value = cur;

    enhanceVideos(doc);
    enhanceEmbeds(doc);
    interceptForms(doc);
    interceptLinks(doc);
    showSavings(doc);
  });

  /** 動画の src を最良コーデックに差し替える */
  function enhanceVideos(doc) {
    var setCodec = function (el) {
      var orig = el.getAttribute("data-dsp-src");
      if (!orig) return;
      el.setAttribute("src", "/video?url=" + encodeURIComponent(orig) + "&codec=" + CODEC);
    };
    var videos = doc.querySelectorAll("video[data-dsp-src]");
    for (var i = 0; i < videos.length; i++) setCodec(videos[i]);
    var sources = doc.querySelectorAll("video source[data-dsp-src]");
    for (var j = 0; j < sources.length; j++) setCodec(sources[j]);
    var vids = doc.querySelectorAll("video.dsp-video");
    for (var k = 0; k < vids.length; k++) {
      try {
        vids[k].load();
      } catch (e) {}
    }
  }

  /** click-to-play: プレースホルダをタップしたら元の埋め込みiframeを展開 */
  function enhanceEmbeds(doc) {
    var embeds = doc.querySelectorAll(".dsp-embed[data-dsp-embed]");
    for (var i = 0; i < embeds.length; i++) {
      (function (ph) {
        var play = function () {
          var src = ph.getAttribute("data-dsp-embed");
          var f = doc.createElement("iframe");
          f.setAttribute("src", src);
          f.setAttribute("width", "100%");
          f.setAttribute("height", "100%");
          f.setAttribute("allow", "autoplay; fullscreen");
          f.setAttribute("allowfullscreen", "");
          f.style.minHeight = "200px";
          ph.replaceWith(f);
        };
        ph.addEventListener("click", play);
        ph.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") play();
        });
      })(embeds[i]);
    }
  }

  /** GETフォーム: action="/browse" + data-target を本来のプロキシURLへ組み立て */
  function interceptForms(doc) {
    var forms = doc.querySelectorAll("form[data-target]");
    for (var i = 0; i < forms.length; i++) {
      (function (f) {
        f.addEventListener("submit", function (e) {
          e.preventDefault();
          var target = f.getAttribute("data-target");
          var params = new URLSearchParams(new FormData(f)).toString();
          var full = target + (target.indexOf("?") === -1 ? "?" : "&") + params;
          navigate(full);
        });
      })(forms[i]);
    }
  }

  /**
   * iframe内リンクのクリックを親で受けて独自履歴に乗せる。
   * （リンクは既に /browse?url=... へ書き換え済みなので、元URLを取り出して
   *   デバイスヒント付きで navigate し直す）
   */
  function interceptLinks(doc) {
    doc.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a) return;
      var href = a.getAttribute("href") || "";
      var m = href.match(/[?&]url=([^&]+)/);
      if (href.indexOf("/browse") !== -1 && m) {
        e.preventDefault();
        navigate(decodeURIComponent(m[1]));
      }
    });
  }

  /** 節約メーター: 元HTMLバイト数 vs 実際に受信したバイト数 */
  function showSavings(doc) {
    var meta = doc.querySelector('meta[name="dsp-original-bytes"]');
    if (!meta) {
      savingsEl.hidden = true;
      return;
    }
    var original = parseInt(meta.getAttribute("content"), 10);
    var delivered = transferSizeOf(iframe.src) || estimateDelivered(doc);
    if (!original || !delivered) {
      savingsEl.hidden = true;
      return;
    }
    var saved = Math.max(0, Math.round((1 - delivered / original) * 100));
    savingsEl.textContent = "節約 " + saved + "%（" + kb(original) + "→" + kb(delivered) + "）";
    savingsEl.hidden = false;
  }

  function transferSizeOf(url) {
    try {
      var entries = performance.getEntriesByType("resource");
      for (var i = entries.length - 1; i >= 0; i--) {
        if (entries[i].name.indexOf("/browse?") !== -1 && entries[i].transferSize) {
          return entries[i].transferSize;
        }
      }
    } catch (e) {}
    return 0;
  }

  function estimateDelivered(doc) {
    try {
      return new Blob([doc.documentElement.outerHTML]).size;
    } catch (e) {
      return 0;
    }
  }

  function kb(n) {
    return Math.round(n / 1024) + "KB";
  }
})();
