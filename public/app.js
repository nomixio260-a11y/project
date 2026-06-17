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
  var minimode = document.getElementById("minimode");
  var iframe = document.getElementById("page");
  var welcome = document.getElementById("welcome");
  var savingsEl = document.getElementById("savings");
  var backBtn = document.getElementById("back");
  var fwdBtn = document.getElementById("forward");
  var reloadBtn = document.getElementById("reload");
  var homeBtn = document.getElementById("home");
  var bookmarkBtn = document.getElementById("bookmark");
  var menuBtn = document.getElementById("menuBtn");
  var menu = document.getElementById("menu");
  var scrim = document.getElementById("scrim");
  var bmList = document.getElementById("bmList");
  var histList = document.getElementById("histList");
  var findbar = document.getElementById("findbar");
  var findInput = document.getElementById("findInput");
  var progress = document.getElementById("progress");

  // ===== 永続化（localStorage） =====
  var LS = window.localStorage;
  function lsGet(key, fallback) {
    try {
      var v = LS.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }
  function lsSet(key, val) {
    try {
      LS.setItem(key, JSON.stringify(val));
    } catch (e) {}
  }

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

  /**
   * アドレスバー入力をURLか検索クエリに解決する。
   * スキーム付き or "ドット有り＆空白なし"（example.com 等）はURL扱い、
   * それ以外は検索エンジンへ（既定DuckDuckGo）。
   */
  function toTarget(input) {
    var s = (input || "").trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[^\s.]+\.[^\s]{2,}($|\/|\?|#|:)/.test(s) || /^localhost(:|\/|$)/.test(s)) {
      return "https://" + s;
    }
    return "https://duckduckgo.com/?q=" + encodeURIComponent(s);
  }

  /** 元URL+モードから /browse パスを組み立てる（デバイスヒントを付与） */
  function buildBrowseUrl(targetUrl) {
    if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "https://" + targetUrl;
    var d = deviceHints();
    var u = "/browse?url=" + encodeURIComponent(targetUrl);
    if (textmode.checked) u += "&text=1";
    if (d.dw) u += "&dw=" + d.dw + "&dpr=" + d.dpr;
    // 省データ最大(Opera Mini相当)はサーバー側で描画＋強圧縮まで行う
    if (minimode.checked) u += "&mini=1";
    else if (spamode.checked) u += "&render=on";
    return u;
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
    load(buildBrowseUrl(targetUrl));
  }

  /** アドレスバー/検索からの遷移（URL or 検索クエリ） */
  function go(input) {
    var t = toTarget(input);
    if (t) navigate(t);
  }

  function goHome() {
    iframe.src = "about:blank";
    welcome.style.display = "";
    address.value = "";
    setBookmarkState(null);
    stopLoading();
  }

  function updateNavButtons() {
    backBtn.disabled = pos <= 0;
    fwdBtn.disabled = pos >= stack.length - 1;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    go(address.value);
  });

  homeBtn.addEventListener("click", goHome);

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
    if (loading) {
      // 読み込み中は停止ボタンとして機能
      try {
        iframe.contentWindow.stop();
      } catch (e) {}
      stopLoading();
      return;
    }
    if (pos >= 0) {
      suppressPush = true;
      load(stack[pos]);
    }
  });

  function saveSettings() {
    lsSet("dsp_settings", {
      text: textmode.checked,
      spa: spamode.checked,
      mini: minimode.checked,
    });
  }

  textmode.addEventListener("change", function () {
    saveSettings();
    var cur = currentProxiedUrl();
    if (cur) navigate(cur);
  });

  spamode.addEventListener("change", function () {
    saveSettings();
    var cur = currentProxiedUrl();
    if (cur) navigate(cur);
  });

  minimode.addEventListener("change", function () {
    // 省データ最大とSPA表示は排他（miniは描画も内包するため）
    if (minimode.checked) spamode.checked = false;
    saveSettings();
    var cur = currentProxiedUrl() || address.value.trim();
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

  // ===== ローディング表示（再読込ボタンは読み込み中だけ「停止」に変わる） =====
  var loading = false;
  function startLoading() {
    loading = true;
    progress.hidden = false;
    reloadBtn.textContent = "✕";
    reloadBtn.title = "停止";
  }
  function stopLoading() {
    loading = false;
    progress.hidden = true;
    reloadBtn.textContent = "⟳";
    reloadBtn.title = "再読み込み";
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

    // アドレスバーを実URLに同期、履歴記録、ブックマーク状態更新
    var cur = currentProxiedUrl();
    if (cur) {
      address.value = cur;
      var title = "";
      try {
        title = (doc.title || "").trim();
      } catch (e) {}
      recordHistory(cur, title);
      setBookmarkState(cur);
    }

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

  // ===== ブックマーク =====
  function getBookmarks() {
    return lsGet("dsp_bookmarks", []);
  }
  function isBookmarked(url) {
    return getBookmarks().some(function (b) {
      return b.url === url;
    });
  }
  function setBookmarkState(url) {
    var on = url && isBookmarked(url);
    bookmarkBtn.textContent = on ? "★" : "☆";
    bookmarkBtn.classList.toggle("on", !!on);
  }
  function toggleBookmark() {
    var url = currentProxiedUrl();
    if (!url) return;
    var list = getBookmarks();
    var idx = list.findIndex(function (b) {
      return b.url === url;
    });
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      var title = "";
      try {
        title = (iframe.contentDocument.title || "").trim();
      } catch (e) {}
      list.unshift({ url: url, title: title || url });
    }
    lsSet("dsp_bookmarks", list);
    setBookmarkState(url);
    renderBookmarks();
  }
  bookmarkBtn.addEventListener("click", toggleBookmark);

  // ===== 履歴 =====
  function recordHistory(url, title) {
    var list = lsGet("dsp_history", []);
    // 直近と同じURLは重複追加しない
    if (list.length && list[0].url === url) {
      if (title) list[0].title = title;
    } else {
      list.unshift({ url: url, title: title || url, ts: Date.now() });
      list = list.slice(0, 200);
    }
    lsSet("dsp_history", list);
  }

  // ===== メニュー（ブックマーク／履歴の描画） =====
  function renderList(ul, items, onDelete) {
    ul.textContent = "";
    if (!items.length) {
      var li = document.createElement("li");
      li.className = "menu-empty";
      li.textContent = "なし";
      ul.appendChild(li);
      return;
    }
    items.forEach(function (it, i) {
      var li = document.createElement("li");
      var a = document.createElement("span");
      a.className = "ml-link";
      a.textContent = it.title || it.url;
      a.title = it.url;
      a.addEventListener("click", function () {
        closeMenu();
        navigate(it.url);
      });
      li.appendChild(a);
      var del = document.createElement("button");
      del.className = "ml-del";
      del.textContent = "✕";
      del.title = "削除";
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        onDelete(i);
      });
      li.appendChild(del);
      ul.appendChild(li);
    });
  }
  function renderBookmarks() {
    renderList(bmList, getBookmarks(), function (i) {
      var list = getBookmarks();
      list.splice(i, 1);
      lsSet("dsp_bookmarks", list);
      renderBookmarks();
      setBookmarkState(currentProxiedUrl());
    });
  }
  function renderHistory() {
    renderList(histList, lsGet("dsp_history", []), function (i) {
      var list = lsGet("dsp_history", []);
      list.splice(i, 1);
      lsSet("dsp_history", list);
      renderHistory();
    });
  }

  function openMenu() {
    renderBookmarks();
    renderHistory();
    menu.hidden = false;
    scrim.hidden = false;
    menuBtn.setAttribute("aria-expanded", "true");
  }
  function closeMenu() {
    menu.hidden = true;
    scrim.hidden = true;
    menuBtn.setAttribute("aria-expanded", "false");
  }
  menuBtn.addEventListener("click", function () {
    if (menu.hidden) openMenu();
    else closeMenu();
  });
  scrim.addEventListener("click", closeMenu);
  document.getElementById("mClear").addEventListener("click", function () {
    lsSet("dsp_history", []);
    renderHistory();
  });
  document.getElementById("mShare").addEventListener("click", function () {
    var url = currentProxiedUrl();
    if (!url) return;
    closeMenu();
    if (navigator.share) navigator.share({ url: url }).catch(function () {});
    else if (navigator.clipboard) {
      navigator.clipboard.writeText(url);
      alert("URLをコピーしました");
    }
  });
  document.getElementById("mFind").addEventListener("click", function () {
    closeMenu();
    openFind();
  });

  // ===== ページ内検索 =====
  function openFind() {
    findbar.hidden = false;
    findInput.value = "";
    findInput.focus();
  }
  function closeFind() {
    findbar.hidden = true;
  }
  function findInPage(forward) {
    var q = findInput.value;
    if (!q) return;
    try {
      // window.find は非標準だが主要ブラウザで利用可。同一オリジンiframe内を検索
      iframe.contentWindow.find(q, false, !forward, true, false, false, false);
    } catch (e) {}
  }
  findInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      findInPage(!e.shiftKey);
    } else if (e.key === "Escape") {
      closeFind();
    }
  });
  document.getElementById("findNext").addEventListener("click", function () {
    findInPage(true);
  });
  document.getElementById("findPrev").addEventListener("click", function () {
    findInPage(false);
  });
  document.getElementById("findClose").addEventListener("click", closeFind);

  // キーボードショートカット（Ctrl/Cmd+F = ページ内検索, Alt+Home = ホーム）
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openFind();
    }
  });

  // ===== 初期化（設定の復元） =====
  (function init() {
    var s = lsGet("dsp_settings", null);
    if (s) {
      textmode.checked = !!s.text;
      spamode.checked = !!s.spa;
      minimode.checked = !!s.mini;
      if (minimode.checked) spamode.checked = false;
    }
    setBookmarkState(null);
  })();
})();
