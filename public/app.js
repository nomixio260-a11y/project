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
    if (livemode.checked) {
      // ライブ操作モード（常駐セッションで対話）。既存sidを再利用して状態を保つ
      u += "&live=1";
      if (currentSid) u += "&sid=" + currentSid;
    } else if (spamode.checked) {
      u += "&render=on";
    }
    return u;
  }

  // ===== ライブ操作モードの状態 =====
  var currentSid = null; // 現在のライブセッションID（ページのmetaから取得）
  var lastLiveUrl = null; // セッション期限切れ時に再オープンする実URL
  var liveQueue = []; // 操作のFIFOキュー（iframe遷移を直列化しレースを防ぐ）
  var liveBusy = false;

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
    // モード切替時はセッションを作り直す（古いsidを引き継がない）
    currentSid = null;
    var cur = currentProxiedUrl() || lastLiveUrl;
    if (cur) navigate(cur);
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

    // ライブ操作モード: セッション状態の取り込みと操作キューの進行
    liveBusy = false;
    if (doc.querySelector('meta[name="dsp-session-gone"]')) {
      // 期限切れ → 同じ実URLでセッションを張り直す
      currentSid = null;
      liveQueue = [];
      if (lastLiveUrl) navigate(lastLiveUrl);
      return;
    }
    var sidMeta = doc.querySelector('meta[name="dsp-session"]');
    currentSid = sidMeta ? sidMeta.getAttribute("content") : null;

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

    // アドレスバーを実URLに同期（ライブ中は dsp-url メタ＝SPA内遷移後のURLを優先）
    var urlMeta = doc.querySelector('meta[name="dsp-url"]');
    var cur = (urlMeta && urlMeta.getAttribute("content")) || currentProxiedUrl();
    if (cur) {
      address.value = cur;
      if (currentSid) lastLiveUrl = cur;
    }

    enhanceVideos(doc);
    enhanceEmbeds(doc);
    if (currentSid) {
      // ライブ中はサーバー側ページへ操作を再現（フォームは操作で処理）
      enhanceLive(doc, currentSid);
    } else {
      interceptForms(doc);
    }
    interceptLinks(doc);
    showSavings(doc);

    // キューに溜まった操作があれば次を実行
    pumpLive();
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

  // ===== ライブ操作モード =====
  // 要素がクリック対象らしいか（SPAはdivにも listener を付けるため cursor:pointer も見る）
  var INTERACTIVE = "a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],[tabindex]";
  function isInteractive(doc, el) {
    if (el.closest && el.closest(INTERACTIVE)) return true;
    try {
      return (doc.defaultView.getComputedStyle(el).cursor || "") === "pointer";
    } catch (e) {
      return false;
    }
  }

  /** 操作をキューへ積み、iframe遷移を直列化して再現する（レース防止） */
  function liveAction(sid, type, params) {
    liveQueue.push({ sid: sid, type: type, params: params || {} });
    if (liveQueue.length > 12) liveQueue.shift(); // 暴走防止
    pumpLive();
  }

  function pumpLive() {
    if (liveBusy || liveQueue.length === 0) return;
    liveBusy = true;
    var a = liveQueue.shift();
    var p = a.params;
    var u = "/interact?sid=" + encodeURIComponent(a.sid) + "&type=" + a.type;
    if (p.ref != null) u += "&ref=" + encodeURIComponent(p.ref);
    if (p.value != null) u += "&value=" + encodeURIComponent(p.value);
    if (p.dy != null) u += "&dy=" + p.dy;
    var d = deviceHints();
    if (d.dw) u += "&dw=" + d.dw + "&dpr=" + d.dpr;
    if (textmode.checked) u += "&text=1";
    load(u); // 完了時の load ハンドラで liveBusy=false → pumpLive
  }

  /** ライブ中のiframe: クリック/入力/送信をサーバー側ページへ再現する */
  function enhanceLive(doc, sid) {
    // 入力値はchange(=blur)時に同期（毎キーストロークは送らず省データ）
    doc.addEventListener(
      "change",
      function (e) {
        var el = e.target;
        if (!el || !el.getAttribute) return;
        var ref = el.getAttribute("data-dsp-ref");
        if (ref == null) return;
        var tag = (el.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") {
          liveAction(sid, "input", { ref: ref, value: el.value });
        }
      },
      true,
    );

    // クリックの再現（プロキシ済みリンクは interceptLinks に委譲）
    doc.addEventListener(
      "click",
      function (e) {
        var t = e.target;
        if (!t || !t.closest) return;
        var a = t.closest("a[href]");
        if (a && (a.getAttribute("href") || "").indexOf("/browse") !== -1) return;
        if (!isInteractive(doc, t)) return; // 無反応な余白クリックで再読込しない
        var el = t.closest("[data-dsp-ref]");
        if (!el) return;
        e.preventDefault();
        liveAction(sid, "click", { ref: el.getAttribute("data-dsp-ref") });
      },
      true,
    );

    // フォーム送信(Enter等): 入力中の値を同期してから送信ボタンをクリック
    doc.addEventListener(
      "submit",
      function (e) {
        e.preventDefault();
        var f = e.target;
        var active = doc.activeElement;
        if (
          active &&
          active.form === f &&
          active.getAttribute &&
          active.getAttribute("data-dsp-ref") != null &&
          /^(input|textarea)$/i.test(active.tagName || "")
        ) {
          liveAction(sid, "input", { ref: active.getAttribute("data-dsp-ref"), value: active.value });
        }
        var btn = f.querySelector(
          'button[type=submit][data-dsp-ref],input[type=submit][data-dsp-ref],button[data-dsp-ref]',
        );
        if (btn) liveAction(sid, "click", { ref: btn.getAttribute("data-dsp-ref") });
      },
      true,
    );
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
