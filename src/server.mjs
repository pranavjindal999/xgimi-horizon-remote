import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteController } from "./controller.mjs";
import { ensureTlsMaterial } from "./tls.mjs";
import { warmYoutubeSearch } from "./youtube.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8095);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const HOST = process.env.HOST || "0.0.0.0";
const STORAGE = process.env.STORAGE_PATH || path.join(ROOT, "data");
const TLS_DIR = process.env.TLS_DIR || path.join(STORAGE, "tls");
/** Public HTTPS origin for PWA install (e.g. Tailscale Serve). */
const PUBLIC_HTTPS_URL = String(process.env.PUBLIC_HTTPS_URL || "").replace(/\/$/, "");
const ICON_CACHE = path.join(ROOT, "cache", "icons");
const homeAdbKey = process.env.HOME
  ? path.join(process.env.HOME, ".android/adbkey")
  : "";
const ADB_KEY = process.env.ADB_VENDOR_KEYS || homeAdbKey;

fs.mkdirSync(STORAGE, { recursive: true });
fs.mkdirSync(ICON_CACHE, { recursive: true });

const STATIC_ICONS = [
  path.join(ROOT, "static", "icons"),
  path.join(ROOT, "web", "public", "icons"),
].find((p) => fs.existsSync(p));

const adbKey = [ADB_KEY, homeAdbKey].find((file) => file && fs.existsSync(file)) || "";

const controller = new RemoteController({
  adbKey,
  storagePath: STORAGE,
  iconCache: ICON_CACHE,
  staticIconDir: STATIC_ICONS,
});

const sockets = new Set();
const webDist = path.join(ROOT, "web", "dist");

let tlsInfo = null;
try {
  tlsInfo = ensureTlsMaterial(TLS_DIR);
} catch (error) {
  console.warn("TLS cert generation failed — HTTPS/PWA disabled:", error.message);
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const socket of sockets) {
    if (socket.readyState === 1) socket.send(data);
  }
}

async function pushState() {
  try {
    const state = await controller.getState();
    broadcast({ type: "state", state });
    return state;
  } catch (error) {
    const prev = controller.lastState || {};
    const missing = /ADB not found/i.test(error.message || "");
    const waking = controller.powerProgress?.active && controller.powerProgress?.kind === "wake";
    const state = {
      ...prev,
      ok: false,
      error: error.message,
      ...(missing && !waking
        ? { powerOn: false, powerMode: "standby", screenOn: false }
        : {}),
    };
    if (missing && !waking) controller.lastState = state;
    broadcast({ type: "state", state });
    return null;
  }
}

let pollTimer = null;
controller.onKeyboard = (open) => {
  broadcast({ type: "keyboard", open: !!open });
};
controller.onPlayback = (state) => {
  broadcast({ type: "state", state });
};
controller.onSuggested = (payload) => {
  broadcast({
    type: "suggested",
    videoId: payload?.videoId || "",
    items: payload?.items || [],
    continuation: payload?.continuation || "",
  });
};
controller.onHistory = (payload) => {
  broadcast({ type: "history", items: payload?.items || [] });
};
controller.onStars = (payload) => {
  broadcast({ type: "stars", items: payload?.items || [] });
};
controller.onSources = (parsed) => {
  broadcast({ type: "sources", sources: parsed?.sources || [] });
};
controller.onPower = (power) => {
  broadcast({ type: "power", power });
};
controller.onReset = () => {
  broadcast({ type: "reset" });
};

function startStateLoop() {
  if (pollTimer) return;
  const tick = async () => {
    if (controller.navigating()) return;
    await controller.pollIme();
    if (controller.navigating()) return;
    await pushState();
  };
  pollTimer = setInterval(tick, 1000);
  tick();
}

let catalogTimer = null;
let catalogBusy = false;
let catalogN = 0;

function startWorld() {
  startStateLoop();
  if (catalogTimer) return;
  const refreshCatalog = async () => {
    if (catalogBusy) return;
    catalogBusy = true;
    catalogN += 1;
    const n = catalogN;
    try {
      try {
        const parsed = await controller.listSources();
        broadcast({ type: "sources", sources: parsed?.sources || [] });
      } catch {
        /* keep the last source list */
      }
      if (n === 1 || n % 8 === 0) {
        try {
          const apps = await controller.listApps();
          broadcast({ type: "apps", apps });
        } catch {
          /* keep the last app list */
        }
        try {
          const device = await controller.deviceInfo({ fresh: n !== 1 });
          broadcast({ type: "device", device });
        } catch {
          /* keep the last device card */
        }
      }
    } finally {
      catalogBusy = false;
    }
  };
  setTimeout(refreshCatalog, 1500);
  catalogTimer = setInterval(refreshCatalog, 8000);
}

async function sendSnapshot(socket) {
  const [history, stars] = await Promise.all([
    controller.youtubeHistory({ limit: 40 }).catch(() => ({ items: [] })),
    controller.youtubeStars({ limit: 40 }).catch(() => ({ items: [] })),
  ]);
  if (socket.readyState !== 1) return;
  socket.send(
    JSON.stringify({
      type: "hello",
      service: "xgimi-remote",
      httpsPort: HTTPS_PORT,
      publicHttpsUrl: PUBLIC_HTTPS_URL || null,
      secure: !!socket._xgSecure,
      power: controller.powerProgress?.active ? controller.powerProgress : null,
      state: controller.lastState,
      apps: controller.apps || [],
      sources: controller.sources?.sources || [],
      history: history?.items || [],
      stars: stars?.items || [],
      device: controller._deviceCache || null,
      suggested: controller.suggested,
    }),
  );
}

async function handleCommand(cmd, signal) {
  const { action } = cmd || {};
  switch (action) {
    case "key":
      return controller.sendKey(cmd.key);
    case "type":
      return controller.typeOnTv({
        text: cmd.text,
        deletes: cmd.deletes,
        enter: cmd.enter,
      });
    case "type.open":
      return controller.openTypeOnTv();
    case "power":
      return controller.setPower(!!cmd.on);
    case "power.shutdown":
      return controller.shutdown();
    case "power.reboot":
      return controller.reboot();
    case "screen":
      return controller.setScreen(!!cmd.on);
    case "mute":
      return controller.setMuted(!!cmd.on);
    case "brightness":
      return controller.setBrightness(cmd.level);
    case "volume":
      if (cmd.delta != null) return controller.volumeDelta(cmd.delta);
      return controller.setVolume(cmd.level);
    case "media":
      return controller.media(cmd.mediaAction || cmd.media, cmd.seconds);
    case "launch":
      return controller.launch(cmd.component, {
        launchByPackage: !!cmd.launchByPackage,
      });
    case "youtube.play":
      return controller.youtubePlay({
        videoId: cmd.videoId,
        query: cmd.query,
        title: cmd.title,
        durationMs: cmd.durationMs,
        length: cmd.length,
        channel: cmd.channel,
      });
    case "youtube.search":
      return { results: await controller.youtubeSearch(cmd.query || "", signal) };
    case "youtube.related":
      return controller.youtubeRelated(cmd.videoId || "", cmd.continuation || "");
    case "youtube.history":
      return controller.youtubeHistory({ limit: cmd.limit });
    case "youtube.stars":
      return controller.youtubeStars({ limit: cmd.limit });
    case "youtube.star":
      return controller.starYoutube(cmd.item || cmd);
    case "youtube.unstar":
      return controller.unstarYoutube(cmd.videoId);
    case "apps":
      return { apps: await controller.listApps() };
    case "device":
      return controller.deviceInfo({ fresh: !!cmd.fresh });
    case "sources":
      return controller.listSources();
    case "source":
      return controller.setSource(String(cmd.id || ""));
    case "state":
      return controller.getState();
    case "state.reset":
      return controller.resetState();
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function createApp(httpsOpts = null) {
  const app = Fastify({
    logger: true,
    ...(httpsOpts ? { https: httpsOpts } : {}),
  });
  await app.register(websocket);

  app.get("/ws", { websocket: true }, (socket) => {
    sockets.add(socket);
    socket._xgSecure = !!httpsOpts;
    void sendSnapshot(socket);

    let searchAbort = null;
    socket.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        socket.send(JSON.stringify({ type: "error", error: "invalid json" }));
        return;
      }
      const id = msg.id;
      let signal;
      if (msg.action === "youtube.search") {
        searchAbort?.abort();
        searchAbort = new AbortController();
        signal = searchAbort.signal;
      }
      try {
        if (msg.action === "key") {
          const result = await handleCommand(msg, signal);
          socket.send(JSON.stringify({ type: "ok", id, result }));
          return;
        }
        const result = await handleCommand(msg, signal);
        socket.send(JSON.stringify({ type: "ok", id, result }));
        if (msg.action === "media") {
          const state = await controller.getState({ fresh: true });
          broadcast({ type: "state", state });
        } else if (
          ![
            "power.shutdown",
            "power.reboot",
            "youtube.search",
            "youtube.related",
            "youtube.history",
            "youtube.stars",
            "youtube.star",
            "youtube.unstar",
            "apps",
            "device",
            "sources",
            "state",
            "state.reset",
            "key",
            "type",
            "type.open",
          ].includes(msg.action)
        ) {
          pushState();
        } else if (msg.action === "state" && result) {
          socket.send(JSON.stringify({ type: "state", state: result }));
        }
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: "error",
            id,
            error: error.message || String(error),
          }),
        );
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "xgimi-remote",
    port: PORT,
    httpsPort: HTTPS_PORT,
    publicHttpsUrl: PUBLIC_HTTPS_URL || null,
    secure: !!httpsOpts,
    ws: "/ws",
    ca: tlsInfo ? "/ca.crt" : null,
  }));

  app.get("/ca.crt", async (_req, reply) => {
    if (!tlsInfo?.ca) {
      reply.code(404);
      return { error: "CA not available" };
    }
    reply.header("Content-Type", "application/x-x509-ca-cert");
    reply.header("Content-Disposition", 'attachment; filename="xgimi-remote-ca.crt"');
    return reply.send(tlsInfo.ca);
  });

  app.post("/api/state/reset", async () => controller.resetState());
  app.get("/api/now-playing.jpg", async (_req, reply) => {
    const file = controller.nowPlayingArtFile();
    if (!file) return reply.code(404).send();
    reply.type("image/jpeg");
    reply.header("Cache-Control", "no-cache");
    return reply.send(fs.createReadStream(file));
  });

  app.get("/api/state", async (_req, reply) => {
    try {
      return await controller.getState();
    } catch (error) {
      reply.code(503);
      return { ok: false, error: error.message };
    }
  });

  app.post("/api/power", async (req) => controller.setPower(!!(req.body?.on ?? true)));
  app.post("/api/power/shutdown", async () => controller.shutdown());
  app.post("/api/power/reboot", async () => controller.reboot());
  app.post("/api/screen", async (req) => controller.setScreen(!!(req.body?.on ?? true)));
  app.post("/api/brightness", async (req) => controller.setBrightness(req.body?.level));
  app.post("/api/mute", async (req) => controller.setMuted(!!req.body?.on));
  app.post("/api/volume", async (req) => {
    if (req.body?.delta != null) return controller.volumeDelta(req.body.delta);
    return controller.setVolume(req.body?.level);
  });
  app.post("/api/key", async (req) => controller.sendKey(req.body?.key));
  app.post("/api/type", async (req) =>
    controller.typeOnTv({
      text: req.body?.text,
      deletes: req.body?.deletes,
      enter: req.body?.enter,
    }),
  );
  app.post("/api/type/open", async () => controller.openTypeOnTv());
  app.post("/api/media", async (req) =>
    controller.media(req.body?.action, req.body?.seconds),
  );
  app.get("/api/apps", async () => ({ apps: await controller.listApps() }));
  app.get("/api/device", async (req) =>
    controller.deviceInfo({ fresh: req.query?.fresh === "1" }),
  );
  app.get("/api/sources", async () => controller.listSources());
  app.post("/api/source", async (req) =>
    controller.setSource(String(req.body?.id || "")),
  );
  app.get("/api/apps/icon", async (req, reply) => {
    const pkg = String(req.query?.pkg || "").trim();
    if (!pkg) {
      reply.code(400);
      return { error: "pkg required" };
    }
    try {
      const file = await controller.appIconPath(pkg);
      if (!file || !fs.existsSync(file)) {
        reply.code(404);
        return { error: "icon not found" };
      }
      const type = file.endsWith(".svg")
        ? "image/svg+xml"
        : file.endsWith(".webp")
          ? "image/webp"
          : file.endsWith(".jpg") || file.endsWith(".jpeg")
            ? "image/jpeg"
            : "image/png";
      reply.type(type);
      return reply.send(fs.createReadStream(file));
    } catch (error) {
      reply.code(404);
      return { error: error.message };
    }
  });
  app.post("/api/apps/launch", async (req) =>
    controller.launch(req.body?.component, {
      launchByPackage: !!req.body?.launchByPackage,
    }),
  );
  app.get("/api/youtube/related", async (req) => {
    const id = String(req.query?.v || "").trim();
    const continuation = String(req.query?.continuation || "");
    if (!id && !continuation) return { results: [], continuation: null };
    return controller.youtubeRelated(id, continuation);
  });
  app.get("/api/youtube/search", async (req) => {
    const q = String(req.query?.q || "").trim();
    if (!q) return { results: [] };
    return { results: await controller.youtubeSearch(q) };
  });
  app.post("/api/youtube/play", async (req) =>
    controller.youtubePlay({
      videoId: req.body?.videoId,
      query: req.body?.query,
      title: req.body?.title,
      durationMs: req.body?.durationMs,
      length: req.body?.length,
      channel: req.body?.channel,
    }),
  );
  app.get("/api/youtube/history", async (req) =>
    controller.youtubeHistory({ limit: req.query?.limit }),
  );
  app.get("/api/youtube/stars", async (req) =>
    controller.youtubeStars({ limit: req.query?.limit }),
  );
  app.post("/api/youtube/star", async (req) => controller.starYoutube(req.body || {}));
  app.post("/api/youtube/unstar", async (req) =>
    controller.unstarYoutube(req.body?.id || req.body?.videoId),
  );

  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      wildcard: false,
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.url === "/ws") {
      reply.code(404).send({ error: "not found" });
      return;
    }
    const index = path.join(webDist, "index.html");
    if (fs.existsSync(index)) {
      reply.type("text/html").send(fs.readFileSync(index));
      return;
    }
    reply.code(404).send("Build the web UI: cd web && npm run build");
  });

  return app;
}

startWorld();

const httpApp = await createApp(null);
await httpApp.listen({ port: PORT, host: HOST });
console.log(`xgimi-remote listening on http://${HOST}:${PORT} (ws /ws)`);

if (tlsInfo) {
  const httpsApp = await createApp({
    key: tlsInfo.key,
    cert: tlsInfo.cert,
    ca: tlsInfo.ca,
  });
  await httpsApp.listen({ port: HTTPS_PORT, host: HOST });
  console.log(
    `xgimi-remote HTTPS on https://${HOST}:${HTTPS_PORT} (PWA) — install CA from /ca.crt`,
  );
  console.log(`TLS SANs cover: ${tlsInfo.ips.join(", ")}`);
}

warmYoutubeSearch();
