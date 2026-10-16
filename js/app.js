"use strict";

/*
 * love-chat — the "Just Us" two-person chat frontend.
 *
 * Talks to love-api /chat/* (see love-api/src/chat.js):
 *   register/login -> Bearer token (localStorage), then
 *   GET  /chat/state        partner presence, unread
 *   GET  /chat/messages     ?after= poll for new messages
 *   POST /chat/messages     send
 *   POST /chat/react        toggle a little emoji on a message
 *   POST /chat/typing       presence pulse while composing
 *   POST /chat/read         read receipt (clears unread server-side)
 *
 * Override the backend with ?api=https://... for local testing.
 */

(function () {
  var API = (function () {
    try {
      return new URLSearchParams(window.location.search).get("api") ||
        "https://love-api.ammarirfan595.workers.dev";
    } catch (e) {
      return "https://love-api.ammarirfan595.workers.dev";
    }
  })();
  var LS_TOKEN = "mena-chat-token";
  var LS_NAME = "mena-chat-name";
  var EMOJIS = ["❤️", "🥰", "😂", "😢", "👍", "🔥", "☕", "✨"];
  var POLL_MS = 3000;
  var STATE_MS = 10000;
  var TYPING_MS = 4000;

  var state = {
    token: null,
    me: null,
    partner: null,
    messages: [],
    byId: {},
    lastTs: 0,
    lastRead: 0,
    mode: "register",
    reactionFor: null,
    lastTypingSent: 0,
    pollTimer: null,
    stateTimer: null,
    busy: false
  };

  function $(id) { return document.getElementById(id); }

  function fmtTime(ts) {
    var d = new Date(ts);
    var h = d.getHours();
    var m = d.getMinutes();
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  function fmtDay(ts) {
    var d = new Date(ts);
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return d.getDate() + " " + months[d.getMonth()];
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ---------- API ---------- */

  function api(path, options) {
    var opts = options || {};
    var headers = { "Content-Type": "application/json" };
    if (state.token) headers["Authorization"] = "Bearer " + state.token;
    return fetch(API + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    }).then(function (res) {
      return res.json().then(function (data) {
        if (res.status === 401 && path !== "/chat/login" && path !== "/chat/register") {
          logout();
          throw new Error("Session expired — sign in again.");
        }
        if (!res.ok) {
          var err = new Error((data && data.error) || "Something went wrong.");
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  /* ---------- auth ---------- */

  function setMode(mode) {
    state.mode = mode;
    var register = mode === "register";
    $("auth-submit").textContent = register ? "Open the room" : "Unlock";
    $("auth-toggle").textContent = register ? "I already have a key" : "We are new here";
    $("auth-note").textContent = register
      ? "First time here? Press “Open the room” to create your half of the chat."
      : "Welcome back — type your name and passphrase to unlock the room.";
  }

  function onAuthSubmit(ev) {
    ev.preventDefault();
    var name = $("auth-name").value.trim();
    var pass = $("auth-pass").value;
    var error = $("auth-error");
    error.textContent = "";
    api(state.mode === "register" ? "/chat/register" : "/chat/login", {
      method: "POST",
      body: { name: name, passphrase: pass }
    }).then(function (data) {
      state.token = data.token;
      state.me = data.user;
      try {
        window.localStorage.setItem(LS_TOKEN, state.token);
        window.localStorage.setItem(LS_NAME, state.me.name);
      } catch (e) { /* private mode etc. */ }
      enterChat();
    }).catch(function (err) {
      error.textContent = err.message || "That didn’t work — try again.";
    });
  }

  function logout() {
    state.token = null;
    state.me = null;
    state.partner = null;
    state.messages = [];
    state.byId = {};
    state.lastTs = 0;
    state.lastRead = 0;
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.stateTimer) clearInterval(state.stateTimer);
    state.pollTimer = null;
    state.stateTimer = null;
    try {
      window.localStorage.removeItem(LS_TOKEN);
      window.localStorage.removeItem(LS_NAME);
    } catch (e) { /* ignore */ }
    $("chat").hidden = true;
    $("auth").hidden = false;
  }

  /* ---------- chat shell ---------- */

  function enterChat() {
    $("auth").hidden = true;
    $("chat").hidden = false;
    $("chat-title").textContent = state.me && state.me.name
      ? state.me.name + " & " + "\u2665"
      : "Just us";
    $("messages").textContent = "";
    state.pollTimer = setInterval(poll, POLL_MS);
    state.stateTimer = setInterval(refreshState, STATE_MS);
    refreshState();
    poll(true);
  }

  function refreshState() {
    if (!state.token) return;
    api("/chat/state").then(function (data) {
      state.partner = data.partner;
      state.lastRead = data.lastRead || 0;
      var status = $("chat-status");
      var typing = $("typing");
      if (!data.partner) {
        status.textContent = "waiting for the other half to register…";
        status.className = "chat-status";
        typing.hidden = true;
      } else if (data.partner.typing) {
        status.textContent = data.partner.name + " is here";
        status.className = "chat-status online";
        typing.textContent = data.partner.name + " is typing…";
        typing.hidden = false;
      } else if (data.partner.online) {
        status.textContent = data.partner.name + " is here";
        status.className = "chat-status online";
        typing.hidden = true;
      } else {
        status.textContent = data.partner.name + " is away right now";
        status.className = "chat-status";
        typing.hidden = true;
      }
    }).catch(function () { /* transient */ });
  }

  /* ---------- messages ---------- */

  function reactionsOf(message) {
    var list = [];
    var reactions = message.reactions || {};
    for (var userId in reactions) {
      if (Object.prototype.hasOwnProperty.call(reactions, userId)) {
        list.push(reactions[userId]);
      }
    }
    return list;
  }

  function paintReactions(node, message) {
    var row = node.reactionsRow;
    if (!row) return;
    row.textContent = "";
    var list = reactionsOf(message);
    if (!list.length) {
      row.hidden = true;
      return;
    }
    list.forEach(function (emoji) { row.appendChild(el("span", null, emoji)); });
    row.hidden = false;
  }

  function addDayDivider(ts) {
    var box = $("messages");
    var last = state.messages[state.messages.length - 1];
    var need = !last || fmtDay(last.ts) !== fmtDay(ts);
    if (need) box.appendChild(el("div", "day-divider", fmtDay(ts)));
  }

  function renderMessage(message) {
    if (state.byId[message.id]) return;
    var box = $("messages");
    addDayDivider(message.ts);
    var mine = message.fromMe || (state.me && message.from === state.me.id);
    var wrap = el("div", "msg " + (mine ? "mine" : "theirs"));
    wrap.setAttribute("data-id", message.id);
    var bubble = el("div", "bubble", message.text);
    var reactionsRow = el("div", "reactions");
    reactionsRow.hidden = true;
    var meta = el("div", "msg-meta", fmtTime(message.ts));
    wrap.appendChild(bubble);
    wrap.appendChild(reactionsRow);
    wrap.appendChild(meta);
    bubble.addEventListener("click", function () { openReactionBar(message.id); });
    box.appendChild(wrap);
    var record = { data: message, wrap: wrap, bubble: bubble, reactionsRow: reactionsRow };
    state.byId[message.id] = record;
    state.messages.push(message);
    paintReactions(record, message);
    box.scrollTop = box.scrollHeight;
  }

  function applyServerMessage(message) {
    var record = state.byId[message.id];
    if (record) {
      record.data = { ...record.data, ...message };
      paintReactions(record, record.data);
    } else {
      renderMessage(message);
    }
    if (message.ts > state.lastTs) state.lastTs = message.ts;
  }

  function markRead(ts) {
    if (!ts || ts <= state.lastRead) return;
    state.lastRead = ts;
    api("/chat/read", { method: "POST", body: { ts: ts } }).catch(function () { /* next poll */ });
  }

  function poll(initial) {
    if (!state.token || state.busy) return;
    state.busy = true;
    api("/chat/messages?after=" + state.lastTs).then(function (data) {
      var latestIncoming = 0;
      (data.messages || []).forEach(function (message) {
        applyServerMessage(message);
        if (!message.fromMe && message.ts > latestIncoming) latestIncoming = message.ts;
      });
      if (latestIncoming) markRead(latestIncoming);
      if (initial && !data.messages.length) {
        var box = $("messages");
        if (!box.children.length) {
          box.appendChild(el("p", "empty-note",
            "Nothing here yet — say the first thing."));
        }
      }
    }).catch(function () { /* transient */ }).then(function () {
      state.busy = false;
    });
  }

  /* ---------- sending ---------- */

  function onComposerInput() {
    var textarea = $("composer-text");
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 128) + "px";
    var now = Date.now();
    if (now - state.lastTypingSent > TYPING_MS) {
      state.lastTypingSent = now;
      api("/chat/typing", { method: "POST", body: {} }).catch(function () { /* ignore */ });
    }
  }

  function onSend(ev) {
    ev.preventDefault();
    var textarea = $("composer-text");
    var text = textarea.value.trim();
    if (!text) return;
    api("/chat/messages", { method: "POST", body: { text: text } }).then(function (data) {
      textarea.value = "";
      textarea.style.height = "auto";
      applyServerMessage(data.message);
      var box = $("messages");
      box.scrollTop = box.scrollHeight;
    }).catch(function (err) {
      $("chat-status").textContent = err.message || "Couldn’t send — try again.";
    });
  }

  /* ---------- reactions ---------- */

  function openReactionBar(id) {
    var bar = $("reaction-bar");
    state.reactionFor = id;
    bar.hidden = false;
    $("reaction-target").value = id;
  }

  function closeReactionBar() {
    $("reaction-bar").hidden = true;
    state.reactionFor = null;
    $("reaction-target").value = "";
  }

  function onReactionPick(ev) {
    var emoji = ev.currentTarget.getAttribute("data-emoji");
    var id = $("reaction-target").value;
    if (!id || !emoji) return;
    api("/chat/react", { method: "POST", body: { id: id, emoji: emoji } })
      .then(function (data) {
        applyServerMessage(data.message);
        closeReactionBar();
      })
      .catch(function (err) {
        $("chat-status").textContent = err.message || "Couldn’t react.";
        closeReactionBar();
      });
  }

  /* ---------- boot ---------- */

  function boot() {
    var emojis = $("reaction-emojis");
    EMOJIS.forEach(function (emoji) {
      var btn = el("button", null, emoji);
      btn.type = "button";
      btn.setAttribute("data-emoji", emoji);
      btn.addEventListener("click", onReactionPick);
      emojis.appendChild(btn);
    });

    $("auth-form").addEventListener("submit", onAuthSubmit);
    $("auth-toggle").addEventListener("click", function () {
      setMode(state.mode === "register" ? "login" : "register");
      $("auth-error").textContent = "";
    });
    $("logout").addEventListener("click", logout);
    $("composer").addEventListener("submit", onSend);
    $("composer-text").addEventListener("input", onComposerInput);
    $("reaction-bar").addEventListener("click", function (ev) {
      if (ev.target.id === "reaction-bar" || ev.target.tagName === "P") closeReactionBar();
    });

    setMode("register");

    var saved = null;
    try { saved = window.localStorage.getItem(LS_TOKEN); } catch (e) { /* ignore */ }
    if (saved) {
      state.token = saved;
      api("/chat/state").then(function (data) {
        state.me = data.me;
        state.lastRead = data.lastRead || 0;
        enterChat();
      }).catch(function () { /* token dead: auth panel is already visible */ });
    }

    if (typeof navigator !== "undefined" && navigator.serviceWorker) {
      try { navigator.serviceWorker.register("sw.js"); } catch (e) { /* ignore */ }
    }
  }

  boot();
})();
