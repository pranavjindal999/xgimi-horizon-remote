/**
 * WebSocket-first client with HTTP fallback.
 * Keys and frequent actions go over WS for lower latency.
 */

let socket = null;
let socketReady = null;
let msgId = 1;
const pending = new Map();
const listeners = new Set();

function wsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function emit(event, data) {
  for (const fn of listeners) fn(event, data);
}

export function onRemoteEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function connect() {
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
    return socketReady;
  }
  socketReady = new Promise((resolve) => {
    const ws = new WebSocket(wsUrl());
    socket = ws;
    ws.onopen = () => {
      emit("open");
      resolve(ws);
    };
    ws.onclose = () => {
      emit("close");
      socket = null;
      socketReady = null;
      setTimeout(connect, 1200);
    };
    ws.onerror = () => {
      // onclose will reconnect
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.type === "error") reject(new Error(msg.error || "error"));
        else resolve(msg.result);
      }
      if (msg.type === "state") emit("state", msg.state);
      if (msg.type === "keyboard") emit("keyboard", msg);
      if (msg.type === "apps") emit("apps", msg.apps);
      if (msg.type === "sources") emit("sources", msg.sources);
      if (msg.type === "device") emit("device", msg.device);
      if (msg.type === "history") emit("history", msg);
      if (msg.type === "stars") emit("stars", msg);
      if (msg.type === "power") emit("power", msg.power);
      if (msg.type === "reset") emit("reset");
      if (msg.type === "suggested") emit("suggested", msg);
      if (msg.type === "hello") {
        emit("hello", msg);
        if (msg.state) emit("state", msg.state);
        if (Array.isArray(msg.apps)) emit("apps", msg.apps);
        if (Array.isArray(msg.sources)) emit("sources", msg.sources);
        if (Array.isArray(msg.history)) emit("history", { items: msg.history });
        if (Array.isArray(msg.stars)) emit("stars", { items: msg.stars });
        if (msg.device) emit("device", msg.device);
        if (msg.suggested?.videoId) emit("suggested", msg.suggested);
      }
    };
  });
  return socketReady;
}

async function wsSend(payload, { timeout = 20000 } = {}) {
  const ws = await connect();
  const id = msgId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("WebSocket timeout"));
    }, timeout);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    ws.send(JSON.stringify({ ...payload, id }));
  });
}

async function http(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || "Request failed");
  return data;
}

connect();

export const api = {
  connect,
  state: () =>
    wsSend({ action: "state" }).catch(() => http("/api/state")),
  apps: () =>
    wsSend({ action: "apps" }).catch(() => http("/api/apps")),
  device: (fresh = false) =>
    wsSend({ action: "device", fresh }, { timeout: 20000 }).catch(() =>
      http(`/api/device${fresh ? "?fresh=1" : ""}`),
    ),
  sources: () =>
    wsSend({ action: "sources" }, { timeout: 12000 }).catch(() => http("/api/sources")),
  source: (id) =>
    wsSend({ action: "source", id }, { timeout: 15000 }).catch(() =>
      http("/api/source", { method: "POST", body: JSON.stringify({ id }) }),
    ),
  key: (key) =>
    wsSend({ action: "key", key }, { timeout: 8000 }).catch(() =>
      http("/api/key", { method: "POST", body: JSON.stringify({ key }) }),
    ),
  type: (body) =>
    wsSend({ action: "type", ...body }, { timeout: 8000 }).catch(() =>
      http("/api/type", { method: "POST", body: JSON.stringify(body) }),
    ),
  typeOpen: () =>
    wsSend({ action: "type.open" }, { timeout: 8000 }).catch(() =>
      http("/api/type/open", { method: "POST", body: "{}" }),
    ),
  power: (on) =>
    wsSend({ action: "power", on }, { timeout: 130000 }).catch(() =>
      http("/api/power", { method: "POST", body: JSON.stringify({ on }) }),
    ),
  powerShutdown: () =>
    wsSend({ action: "power.shutdown" }, { timeout: 50000 }).catch(() =>
      http("/api/power/shutdown", { method: "POST", body: "{}" }),
    ),
  powerReboot: () =>
    wsSend({ action: "power.reboot" }, { timeout: 190000 }).catch(() =>
      http("/api/power/reboot", { method: "POST", body: "{}" }),
    ),
  screen: (on) =>
    wsSend({ action: "screen", on }).catch(() =>
      http("/api/screen", { method: "POST", body: JSON.stringify({ on }) }),
    ),
  mute: (on) =>
    wsSend({ action: "mute", on }).catch(() =>
      http("/api/mute", { method: "POST", body: JSON.stringify({ on }) }),
    ),
  brightness: (level) =>
    wsSend({ action: "brightness", level }).catch(() =>
      http("/api/brightness", {
        method: "POST",
        body: JSON.stringify({ level }),
      }),
    ),
  volume: (body) =>
    wsSend({ action: "volume", ...body }).catch(() =>
      http("/api/volume", { method: "POST", body: JSON.stringify(body) }),
    ),
  media: (mediaAction, seconds) =>
    wsSend({ action: "media", mediaAction, seconds }).catch(() =>
      http("/api/media", {
        method: "POST",
        body: JSON.stringify({ action: mediaAction, seconds }),
      }),
    ),
  launch: (component, launchByPackage = false) =>
    wsSend({ action: "launch", component, launchByPackage }).catch(() =>
      http("/api/apps/launch", {
        method: "POST",
        body: JSON.stringify({ component, launchByPackage }),
      }),
    ),
  youtubeSearch: (query) =>
    wsSend({ action: "youtube.search", query }).catch(() =>
      http(`/api/youtube/search?q=${encodeURIComponent(query)}`),
    ),
  youtubeRelated: (videoId, continuation = "") =>
    wsSend({ action: "youtube.related", videoId, continuation }).catch(() => {
      const params = new URLSearchParams();
      if (videoId) params.set("v", videoId);
      if (continuation) params.set("continuation", continuation);
      return http(`/api/youtube/related?${params}`);
    }),
  youtubePlay: (body) =>
    wsSend({ action: "youtube.play", ...body }, { timeout: 170000 }),
  resetState: () =>
    wsSend({ action: "state.reset" }, { timeout: 25000 }).catch(() =>
      http("/api/state/reset", { method: "POST", body: "{}" }),
    ),
  youtubeHistory: (limit = 40) =>
    wsSend({ action: "youtube.history", limit }, { timeout: 8000 }).catch(() =>
      http(`/api/youtube/history?limit=${encodeURIComponent(limit)}`),
    ),
  youtubeStars: (limit = 40) =>
    wsSend({ action: "youtube.stars", limit }, { timeout: 8000 }).catch(() =>
      http(`/api/youtube/stars?limit=${encodeURIComponent(limit)}`),
    ),
  youtubeStar: (item) =>
    wsSend({ action: "youtube.star", item }, { timeout: 8000 }).catch(() =>
      http("/api/youtube/star", { method: "POST", body: JSON.stringify(item) }),
    ),
  youtubeUnstar: (videoId) =>
    wsSend({ action: "youtube.unstar", videoId }, { timeout: 8000 }).catch(() =>
      http("/api/youtube/unstar", {
        method: "POST",
        body: JSON.stringify({ id: videoId }),
      }),
    ),
};
