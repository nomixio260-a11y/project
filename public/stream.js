/**
 * 映像ストリーミング方式リモートブラウザのクライアント制御。
 *
 * WS /stream に接続し、サーバーから届くJPEGフレームを <img id="screen"> に描画。
 * マウス/ホイール/キーボードを座標変換してサーバーへ送り返し、実ページを操作する。
 * 動画再生を含む完全な操作が可能（通信は映像なので相応のデータ量）。
 *
 * window.DSPStream として app.js から利用する。
 */
(function () {
  "use strict";

  var streamEl = document.getElementById("stream");
  var screen = document.getElementById("screen");
  var status = document.getElementById("streamStatus");

  var ws = null;
  var active = false;
  var vw = 0,
    vh = 0;
  var urlCb = null;
  var lastMove = 0;

  function setStatus(text) {
    if (!text) {
      status.hidden = true;
    } else {
      status.textContent = text;
      status.hidden = false;
    }
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  /** 表示画像上の座標 → サーバービューポート座標へ変換 */
  function pt(e) {
    var r = screen.getBoundingClientRect();
    if (!r.width || !r.height) return { x: 0, y: 0 };
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * vw),
      y: Math.round(((e.clientY - r.top) / r.height) * vh),
    };
  }

  function btnName(b) {
    return b === 2 ? "right" : b === 1 ? "middle" : "left";
  }

  // ===== 入力ハンドラ（一度だけ登録） =====
  screen.addEventListener("mousemove", function (e) {
    if (!active) return;
    var now = Date.now();
    if (now - lastMove < 40) return; // 約25fpsに間引いて送信量を抑制
    lastMove = now;
    var p = pt(e);
    send({ type: "mousemove", x: p.x, y: p.y, buttons: e.buttons });
  });
  screen.addEventListener("mousedown", function (e) {
    if (!active) return;
    e.preventDefault();
    streamEl.focus();
    var p = pt(e);
    send({ type: "mousedown", x: p.x, y: p.y, button: btnName(e.button) });
  });
  screen.addEventListener("mouseup", function (e) {
    if (!active) return;
    e.preventDefault();
    var p = pt(e);
    send({ type: "mouseup", x: p.x, y: p.y, button: btnName(e.button) });
  });
  screen.addEventListener(
    "wheel",
    function (e) {
      if (!active) return;
      e.preventDefault();
      var p = pt(e);
      send({ type: "wheel", x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY });
    },
    { passive: false },
  );
  screen.addEventListener("contextmenu", function (e) {
    if (active) e.preventDefault();
  });

  // キーボード（ストリーム面にフォーカスがある時のみ）
  var SPECIAL = {
    Enter: 1, Backspace: 1, Tab: 1, Escape: 1, Delete: 1,
    ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1,
    Home: 1, End: 1, PageUp: 1, PageDown: 1,
  };
  streamEl.addEventListener("keydown", function (e) {
    if (!active) return;
    if (e.ctrlKey || e.metaKey) return; // ブラウザのショートカットは透過
    if (e.key.length === 1 && !e.altKey) {
      e.preventDefault();
      send({ type: "text", text: e.key });
    } else if (SPECIAL[e.key]) {
      e.preventDefault();
      send({ type: "key", key: e.key });
    }
  });

  function attachListenersDone() {}

  function teardown() {
    active = false;
    if (ws) {
      try {
        ws.onclose = null;
        ws.close();
      } catch (e) {}
      ws = null;
    }
    screen.removeAttribute("src");
  }

  var DSPStream = {
    /** ストリーミング開始。targetUrl=実URL, opts={dw,dpr} */
    open: function (targetUrl, opts) {
      teardown();
      opts = opts || {};
      streamEl.hidden = false;
      setStatus("接続中…");
      var proto = location.protocol === "https:" ? "wss:" : "ws:";
      var u = proto + "//" + location.host + "/stream?url=" + encodeURIComponent(targetUrl);
      if (opts.dw) u += "&dw=" + opts.dw + "&dpr=" + (opts.dpr || 1);
      ws = new WebSocket(u);
      ws.onmessage = function (ev) {
        var m;
        try {
          m = JSON.parse(ev.data);
        } catch (e) {
          return;
        }
        if (m.t === "frame") {
          screen.src = "data:image/jpeg;base64," + m.data;
        } else if (m.t === "ready") {
          vw = m.vw;
          vh = m.vh;
          active = true;
          setStatus("");
          streamEl.focus();
          if (urlCb && m.url) urlCb(m.url);
        } else if (m.t === "url") {
          if (urlCb) urlCb(m.url);
        } else if (m.t === "error") {
          active = false;
          setStatus("エラー: " + m.message);
        }
      };
      ws.onclose = function () {
        if (streamEl.hidden) return;
        active = false;
        setStatus("接続が切断されました");
      };
      ws.onerror = function () {
        setStatus("接続エラー");
      };
    },

    /** ストリームを維持したまま別URLへ遷移（アドレスバーからの移動用） */
    navigate: function (targetUrl) {
      if (active) send({ type: "navigate", url: targetUrl });
    },

    /** URL変化（SPA内遷移・サーバー遷移）の通知先 */
    onUrl: function (cb) {
      urlCb = cb;
    },

    isActive: function () {
      return active;
    },

    close: function () {
      teardown();
      streamEl.hidden = true;
      setStatus("");
    },
  };

  attachListenersDone();
  window.DSPStream = DSPStream;
})();
