/**
 * 親シェルのスクリプト。プロキシ済みページ（同一オリジンのiframe）はJSを
 * 除去済みなので、対話的処理は全てここ（親）から行う:
 *   - URL移動 / テキストモード切替
 *   - iframe内リンク・GETフォームのプロキシ経由ナビ補助
 *   - 動画コーデックのクライアント能力判定 → /video の codec 差し替え
 *   - 埋め込み動画の click-to-play 展開
 *   - 節約メーター表示
 */
(function () {
  "use strict";

  var form = document.getElementById("nav");
  var address = document.getElementById("address");
  var textmode = document.getElementById("textmode");
  var iframe = document.getElementById("page");
  var welcome = document.getElementById("welcome");
  var savingsEl = document.getElementById("savings");

  /** クライアントが再生可能な最良コーデックを判定（AV1 → VP9 → H.264） */
  function bestCodec() {
    var v = document.createElement("video");
    if (v.canPlayType('video/webm; codecs="av01.0.05M.08"')) return "av1";
    if (v.canPlayType('video/webm; codecs="vp9"')) return "vp9";
    return "h264";
  }
  var CODEC = bestCodec();

  function navigate(targetUrl) {
    if (!targetUrl) return;
    if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "https://" + targetUrl;
    var u = "/browse?url=" + encodeURIComponent(targetUrl);
    if (textmode.checked) u += "&text=1";
    welcome.style.display = "none";
    iframe.src = u;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    navigate(address.value.trim());
  });

  textmode.addEventListener("change", function () {
    // 現在表示中のURLを同モードで再読み込み
    var cur = currentProxiedUrl();
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

  iframe.addEventListener("load", function () {
    var doc;
    try {
      doc = iframe.contentDocument;
    } catch (e) {
      return; // クロスオリジン（パススルー等）はスキップ
    }
    if (!doc) return;

    // アドレスバーを実URLに同期
    var cur = currentProxiedUrl();
    if (cur) address.value = cur;

    enhanceVideos(doc);
    enhanceEmbeds(doc);
    interceptForms(doc);
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
    // source差し替え後は load() で反映
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
