import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  configureAdbDiscover,
  invalidateAdbHost,
  projectorLastIp,
  projectorMac,
  resolveAdbHost,
} from "./adb-discover.mjs";
import { adbPullBytes, adbShell } from "./adb.mjs";
import { ensureAppIcon, listLeanbackApps, launchApp, warmAppIcons } from "./apps.mjs";
import { keyeventFor } from "./keys.mjs";
import { parseMuted, parseNowPlaying, youtubeThumb } from "./media.mjs";
import { DEVICE_SHELL, parseDeviceDump } from "./device.mjs";
import { Projector, broadcastWake } from "./projector.mjs";
import { SOURCE_DUMP, parseSourceDump, sourceCommand } from "./sources.mjs";
import { evaluatePower, freshPowerSteps, powerSnapshot } from "./wake.mjs";
import {
  ensureHistoryFile,
  listYoutubeHistory,
  patchYoutubeHistoryItem,
  recordYoutubePlay,
} from "./history.mjs";
import {
  ensureStarsFile,
  listYoutubeStars,
  starYoutube as saveYoutubeStar,
  unstarYoutube as removeYoutubeStar,
} from "./stars.mjs";
import {
  parseLengthToMs,
  relatedYoutubeVideos,
  searchYoutubeSuggestions,
  searchYoutubeVideo,
  titlesCompatible,
  normalizeTitle,
  resolutionFromSize,
  resolutionFromText,
  youtubeVideoMeta,
  youtubeLaunchCommand,
  configureResolutionStore,
  rememberResolution,
} from "./youtube.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const queueSlot = new AsyncLocalStorage();

function isYoutubePackage(pkg) {
  return String(pkg || "").toLowerCase().includes("youtube");
}

/** Session titles drop the artist and shorten “feat”, so exact equality is not enough. */
function titlesShare(a, b) {
  if (titlesCompatible(a, b)) return true;
  const words = (text) =>
    normalizeTitle(text)
      .split(" ")
      .filter((word) => word.length > 3 && word !== "feat" && word !== "official" && word !== "video");
  const left = words(a);
  const right = new Set(words(b));
  if (!left.length || !right.size) return false;
  const hit = left.filter((word) => right.has(word)).length;
  return hit >= Math.min(2, left.length) && hit / left.length >= 0.6;
}

/** Same title from two artists must not share one video id. */
function trackKey(title, artist) {
  const t = String(title || "").trim().toLowerCase();
  const a = String(artist || "").trim().toLowerCase();
  if (!t) return "";
  return a && a !== t ? `${t}\n${a}` : t;
}

/** Last `event:started` line for a YouTube movie track. */
function latestYoutubeStart(raw) {
  const ids = new Set();
  const idRe = /piid:(\d+)[^\n]*(?:uid|u)\/pid:10086\//g;
  let m;
  while ((m = idRe.exec(String(raw || "")))) ids.add(m[1]);
  let last = null;
  for (const line of String(raw || "").split("\n")) {
    const hit = /player piid:(\d+) event:started/.exec(line);
    if (hit && ids.has(hit[1])) last = line.trim();
  }
  return last;
}

function startStamp(line) {
  return /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(line || "")?.[1] || "";
}

const SEEK_JAR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../device/seek.jar",
);
const SEEK_REMOTE = "/data/local/tmp/seek.jar";

function livePositionMs(nowPlaying) {
  if (!nowPlaying || nowPlaying.positionMs == null) return null;
  let pos = nowPlaying.positionMs;
  if (nowPlaying.playing && nowPlaying.progressAt) {
    pos += Math.max(0, Date.now() - nowPlaying.progressAt);
  }
  if (nowPlaying.durationMs > 0) pos = Math.min(nowPlaying.durationMs, pos);
  return Math.max(0, pos);
}

export class RemoteController {
  constructor({ adbKey, storagePath, iconCache, staticIconDir } = {}) {
    this.adbKey = adbKey || process.env.ADB_VENDOR_KEYS || "";
    this.host = null;
    this.projector = null;
    this.lastState = null;
    this.apps = [];
    this.sources = null;
    this._shownPlaying = null;
    this._shownAt = 0;
    this._seek = null;
    this._seekGen = 0;
    this._pendingBrightness = null;
    this._pendingBrightnessUntil = 0;
    this._pendingScreen = null;
    this._pendingScreenUntil = 0;
    this._pendingMuted = null;
    this._pendingMutedUntil = 0;
    this._volumeBeforeMute = null;
    this._muteVolumeTarget = null;
    this._starting = null;
    this._startingPrev = null;
    this._startedHold = null;
    this._leftTitle = "";
    this._switchedAt = 0;
    this._ytLookup = "";
    this.lastYoutubeId = null;
    this.lastYoutubeTitleKey = null;
    this.lastYoutubeTrackKey = null;
    this.titleToVideoId = new Map();
    this.iconCache = iconCache || path.join(storagePath || ".", "icons");
    this.staticIconDir = staticIconDir || null;
    this._inflightState = null;
    this._chain = Promise.resolve();
    this._keyChain = Promise.resolve();
    this._navUntil = 0;
    this._queueDepth = 0;
    this._pendingVolume = null;
    this._volumeRunning = false;
    this._volumeToken = 0;
    // YouTube writes PlaybackState.updated on its own clock, not elapsedRealtime.
    // clockOffset = elapsedRealtime - updated, captured on a fresh write.
    this._clockOffset = null;
    this._clockTitle = null;
    this._durationMs = null;
    this._durationFor = null;
    this._resolution = null;
    this._resolutionFor = null;
    this._resolutionInflight = false;
    this._durationInflight = new Set();
    this._sessionDurationMs = null;
    this._sessionDurationFor = null;
    this._sessionDurationSkip = null;
    this._sessionDurationSkipUntil = 0;
    this._artFor = "";
    this._artInflight = "";
    this._artGen = 0;
    this._idFor = "";
    this._idInflight = "";
    this._idTryKey = "";
    this._idTryAt = 0;
    this._idMiss = new Map();
    this._cobaltChild = null;
    this._cobaltWatch = false;
    this._fastId = "";
    this._fastTitle = "";
    this._fastArtist = "";
    this._fastUntil = 0;
    this._launchId = "";
    this._launchTitle = "";
    this._launchUntil = 0;
    this._seekJarReady = false;
    this._searchOpen = false;
    this._imeShown = false;
    this._keyboardOpen = false;
    this._navChild = null;
    this._navHost = null;
    this._navBuf = "";
    this._imeInflight = null;
    this.onKeyboard = null;
    this.onPlayback = null;
    this.onSuggested = null;
    this.suggested = null;
    this._suggestedFor = "";
    this.onHistory = null;
    this.onStars = null;
    this.onSources = null;
    this.onPower = null;
    this.onReset = null;
    this.powerProgress = null;
    this._historyRecordedId = null;
    this._deviceCache = null;
    this._deviceAt = 0;
    this._deviceInflight = null;
    this._playWatchGen = 0;
    this._playWatchTimer = null;
    this._chosenSource = null;
    this._chosenAt = 0;
    this.storagePath = storagePath || ".";
    ensureHistoryFile(this.storagePath);
    ensureStarsFile(this.storagePath);
    configureResolutionStore(this.storagePath);
    configureAdbDiscover({ storagePath });
    void listYoutubeHistory(this.storagePath, { limit: 80 })
      .then((items) => {
        for (const row of items) {
          if (row?.id && row.resolution) rememberResolution(row.id, row.resolution);
        }
      })
      .catch(() => {});
  }

  async ensureHost() {
    if (this.host && this.projector) {
      this.#ensureNavWatch();
      return this.host;
    }
    this.host = await resolveAdbHost(this.adbKey);
    this.projector = new Projector(this.host);
    this.#ensureNavWatch();
    return this.host;
  }

  /** On-demand projector details. Not part of the 1s state poll. */
  async deviceInfo({ fresh = false } = {}) {
    await this.ensureHost();
    const now = Date.now();
    if (!fresh && this._deviceCache && now - this._deviceAt < 20_000) {
      return this._deviceCache;
    }
    if (this._deviceInflight) return this._deviceInflight;
    this._deviceInflight = (async () => {
      const raw = await this.projector.shell(DEVICE_SHELL, 12_000);
      const info = parseDeviceDump(raw);
      info.adb = this.host;
      info.fetchedAt = Date.now();
      this._deviceCache = info;
      this._deviceAt = info.fetchedAt;
      return info;
    })().finally(() => {
      this._deviceInflight = null;
    });
    return this._deviceInflight;
  }

  async listSources() {
    await this.ensureHost();
    const raw = await this.projector.shell(SOURCE_DUMP, 8_000);
    const parsed = parseSourceDump(raw);
    const remembered = this._chosenSource;
    const fresh = Date.now() - this._chosenAt < 4000;
    if (parsed.onHdmi && (remembered === "hdmi1" || remembered === "hdmi2")) {
      // The passthrough activity keeps the first launch intent, so the dump
      // still says HDMI 1 after a later switch.
      parsed.current = remembered;
    } else if (!parsed.onHdmi && (remembered === "hdmi1" || remembered === "hdmi2") && fresh) {
      parsed.current = remembered;
    } else if (!parsed.onHdmi) {
      parsed.current = "apps";
      if (!fresh) this._chosenSource = "apps";
    }
    parsed.sources = parsed.sources.map((item) => ({
      ...item,
      active: item.id === parsed.current,
    }));
    this.sources = parsed;
    return parsed;
  }

  async setSource(id) {
    const command = sourceCommand(id);
    if (!command) throw new Error("Unknown source");
    this._chosenSource = id;
    this._chosenAt = Date.now();
    if (this.sources?.sources) {
      this.sources = {
        ...this.sources,
        current: id,
        onHdmi: id === "hdmi1" || id === "hdmi2",
        sources: this.sources.sources.map((item) => ({
          ...item,
          active: item.id === id,
        })),
      };
      this.#publishSources();
    }
    const parsed = await this.enqueue(async () => {
      await this.ensureHost();
      await this.projector.shell(command, 12_000);
      await sleep(400);
      return this.listSources();
    });
    this.#publishSources();
    return parsed;
  }

  #publish() {
    if (!this.lastState) return;
    try {
      this.onPlayback?.(this.lastState);
    } catch {
      /* a closed tab should not block the command */
    }
  }

  #publishSources() {
    if (!this.sources?.sources?.length) return;
    try {
      this.onSources?.(this.sources);
    } catch {
      /* a closed tab should not block the command */
    }
  }

  #patchPlayback(partial) {
    if (!this.lastState?.nowPlaying) return;
    this.lastState = {
      ...this.lastState,
      nowPlaying: { ...this.lastState.nowPlaying, ...partial },
    };
    this.#publish();
  }

  /**
   * Seeking is part of the shared snapshot. Every tab shows the target and
   * the "Seeking" label until the projector reports that position.
   */
  #beginSeek(action, seconds) {
    const np = this.lastState?.nowPlaying;
    if (!np) return null;
    const from = this._seek?.target ?? livePositionMs(np);
    if (action === "seek" && from == null) return null;
    let target =
      action === "seek_to"
        ? Math.max(0, Math.round(Number(seconds) || 0) * 1000)
        : from + Math.round(Number(seconds) || 0) * 1000;
    const dur = Number(np.durationMs) || Number(this._sessionDurationMs) || 0;
    if (dur > 0) target = Math.min(Math.max(0, dur - 400), Math.max(0, target));
    else target = Math.max(0, target);
    const gen = ++this._seekGen;
    this._seek = {
      gen,
      target,
      from: from ?? target,
      phase: "running",
      until: 0,
      wasPlaying: this._seek ? this._seek.wasPlaying : !!np.playing,
    };
    this.#patchPlayback({
      positionMs: target,
      progressAt: Date.now(),
      progressSynced: true,
      seeking: true,
      playing: false,
    });
    return { gen, target };
  }

  #finishSeek(gen, landedMs) {
    const seek = this._seek;
    if (!seek || seek.gen !== gen) return;
    const until = Date.now() + 4000;
    this._seek = { ...seek, phase: "landed", target: landedMs, until };
    this.#patchPlayback({
      seeking: true,
      positionMs: landedMs,
      durationMs: this._sessionDurationMs || this.lastState?.nowPlaying?.durationMs,
      progressAt: Date.now(),
      progressSynced: true,
      playing: false,
      paused: false,
    });
    setTimeout(() => this.#releaseSeek(gen), 4000);
  }

  #failSeek(gen) {
    const seek = this._seek;
    if (!seek || seek.gen !== gen) return;
    this._seek = null;
    this.#patchPlayback({
      seeking: false,
      positionMs: seek.from,
      progressAt: Date.now(),
      progressSynced: true,
      playing: !!seek.wasPlaying,
      paused: !seek.wasPlaying,
      state: seek.wasPlaying ? "PLAYING" : "PAUSED",
    });
  }

  #releaseSeek(gen) {
    const seek = this._seek;
    if (!seek || seek.gen !== gen || seek.phase !== "landed") return;
    this._seek = null;
    this.#patchPlayback({
      seeking: false,
      positionMs: seek.target,
      progressAt: Date.now(),
      progressSynced: true,
      playing: true,
      paused: false,
      state: "PLAYING",
    });
  }

  #overlaySeek(nowPlaying) {
    const seek = this._seek;
    if (!seek) return { ...nowPlaying, seeking: false };
    if (seek.phase === "running") {
      return {
        ...nowPlaying,
        positionMs: seek.target,
        progressAt: Date.now(),
        progressSynced: true,
        seeking: true,
        playing: false,
      };
    }
    const pos = nowPlaying.positionMs;
    const forward = seek.target >= seek.from;
    const arrived =
      pos != null &&
      (forward ? pos >= seek.target - 1500 : pos <= seek.target + 1500);
    if (arrived || Date.now() >= seek.until) {
      this._seek = null;
      return { ...nowPlaying, seeking: false };
    }
    return {
      ...nowPlaying,
      positionMs: seek.target,
      progressAt: Date.now(),
      progressSynced: true,
      seeking: true,
      playing: false,
    };
  }

  #rememberVolume(volume) {
    if (!this.lastState || volume == null) return;
    if (this.lastState.muted || this._pendingMuted === true) {
      this._pendingMuted = false;
      this._pendingMutedUntil = Date.now() + 6000;
      this._volumeBeforeMute = null;
      this._muteVolumeTarget = volume;
      this.lastState.muted = false;
    }
    this.lastState.volume = volume;
    this.#publish();
  }

  /** Serialize projector mutations so slider spam can't race keyevent batches. */
  enqueue(fn) {
    if (queueSlot.getStore()) return fn();
    const run = this._chain.then(() =>
      queueSlot.run(true, async () => {
        this._queueDepth += 1;
        try {
          return await fn();
        } finally {
          this._queueDepth -= 1;
        }
      }),
    );
    this._chain = run.catch(() => {});
    return run;
  }

  async withProjector(fn) {
    return this.enqueue(async () => {
      await this.ensureHost();
      try {
        return await fn(this.projector, this.host);
      } catch (error) {
        const text = `${error?.message ?? ""}`;
        if (/unable to connect|device offline|not found|timeout/i.test(text)) {
          invalidateAdbHost(this.host);
          this.host = null;
          this.projector = null;
          await this.ensureHost();
          return fn(this.projector, this.host);
        }
        throw error;
      }
    });
  }

  async getState({ fresh = false } = {}) {
    // Coalesce concurrent polls — but mutations must pass fresh:true so they
    // don't reuse a state snapshot that started before the change.
    if (!fresh && this._inflightState) return this._inflightState;
    const run = this.withProjector(async (p, host) => {
      try {
        const raw = await p.shell(
          [
            p.readCommandPublic(),
            "echo __XG_MEDIA__",
            "dumpsys media_session",
            "echo __XG_AUDIO__",
            "dumpsys audio",
            "echo __XG_ELAPSED__",
            "dumpsys alarm | grep -m 1 nowELAPSED",
            "echo __XG_IME__",
            "dumpsys input_method | grep mInputShown | head -1",
          ].join("; "),
          18_000,
        );
        const [corePart, rest0 = ""] = raw.split("__XG_MEDIA__");
        const [mediaPart = "", rest1 = ""] = rest0.split("__XG_AUDIO__");
        const [audioPart = "", afterAudio = ""] = rest1.split("__XG_ELAPSED__");
        const [elapsedPart = "", imePart = ""] = afterAudio.split("__XG_IME__");
        const elapsedMs = Number(/nowELAPSED=(\d+)/.exec(elapsedPart)?.[1]);
        let elapsed = Number.isFinite(elapsedMs) ? elapsedMs : null;
        const { parseState } = await import("./state.mjs");
        const state = parseState(corePart);
        const nowPlaying = parseNowPlaying(mediaPart);
        if (
          !nowPlaying.title ||
          String(nowPlaying.title).trim().toLowerCase() === "null"
        ) {
          nowPlaying.title = null;
        }
        const muted = parseMuted(audioPart);

        if (isYoutubePackage(nowPlaying.package) && (nowPlaying.title || this._fastId)) {
          this.#holdFastPlay(nowPlaying);
        }
        if (isYoutubePackage(nowPlaying.package) && nowPlaying.title) {
          const titleKey = String(nowPlaying.title).trim().toLowerCase();
          const key = trackKey(nowPlaying.title, nowPlaying.artist);
          let vid = this.titleToVideoId.get(key) || null;
          if (
            !vid &&
            this.lastYoutubeId &&
            this.lastYoutubeTrackKey === key &&
            (this.lastYoutubeTitleKey === titleKey ||
              titlesCompatible(nowPlaying.title, this.lastYoutubeTitleKey))
          ) {
            vid = this.lastYoutubeId;
          }
          if (
            !vid &&
            this.lastYoutubeId &&
            titlesShare(nowPlaying.title, this.lastYoutubeTitleKey)
          ) {
            vid = this.lastYoutubeId;
          }
          if (
            !vid &&
            this._launchId &&
            Date.now() < this._launchUntil &&
            titlesShare(nowPlaying.title, this._launchTitle)
          ) {
            vid = this._launchId;
          }
          if (!vid && this.lastState?.nowPlaying?.videoId) {
            const prev = this.lastState.nowPlaying;
            if (
              prev.package &&
              isYoutubePackage(prev.package) &&
              trackKey(prev.title, prev.artist) === key
            ) {
              vid = prev.videoId;
            }
          }
          const guess =
            (vid && this._resolutionFor === vid ? this._resolution : null) ||
            resolutionFromText(nowPlaying.title, nowPlaying.artist);
          if (guess) nowPlaying.resolution = guess;
          if (vid) {
            this.#stampYoutube(nowPlaying, vid);
            if (nowPlaying.playing) this.#ensurePlaybackResolution(p, vid);
            this.#noteHistoryFromNowPlaying(nowPlaying);
          } else {
            void this.#capturePlayingId(p, nowPlaying);
            if (this._artFor === key && this._artGen) {
              nowPlaying.thumb = `/api/now-playing.jpg?v=${this._artGen}`;
            } else {
              void this.#refreshSessionPicture(p, nowPlaying);
            }
          }
        } else if (!isYoutubePackage(nowPlaying.package)) {
          this.lastYoutubeTitleKey = null;
        }

        if (
          isYoutubePackage(nowPlaying.package) &&
          nowPlaying.playing &&
          this._clockOffset == null
        ) {
          const snap = await this.#syncPlaybackClock(p);
          if (snap) {
            nowPlaying.positionMs = snap.positionMs;
            nowPlaying.positionUpdatedMs = snap.updatedMs;
            nowPlaying.playing = true;
            nowPlaying.paused = false;
            elapsed = snap.elapsed;
          }
        }
        if (nowPlaying.title) {
          // Duration is already known from the click. Don't hold the
          // playing signal behind another shell.
          void this.#refreshSessionDuration(p, nowPlaying.title);
        }
        this.#applyProgress(nowPlaying, elapsed);
        const settled = this.#overlayStarting(
          this.#overlaySeek(this.#rememberNowPlaying(nowPlaying)),
        );
        const held = this.#applyScreenHold(this.#applyBrightnessHold(state));
        const audio = this.#applyMuteHold(held.volume, muted);
        const brightnessScale = held.luminanceBoost ? 11 : held.brightness;
        this.lastState = {
          ...held,
          volume: audio.volume,
          brightnessScale,
          muted: audio.muted,
          nowPlaying: settled,
          keyboardOpen: /mInputShown=true/.test(imePart) || !!this._searchOpen,
          host,
          ok: true,
          error: null,
          powerMode: state.powerOn ? "on" : "standby",
        };
        } catch (error) {
        this.lastState = {
          ...(this.lastState || {}),
          host,
          ok: false,
          error: error.message,
        };
      }
      return this.lastState;
    });
    if (!fresh) {
      this._inflightState = run.finally(() => {
        this._inflightState = null;
      });
      return this._inflightState;
    }
    return run;
  }

  #stampYoutube(nowPlaying, vid) {
    const titleKey = String(nowPlaying.title || "").trim().toLowerCase();
    nowPlaying.videoId = vid;
    nowPlaying.thumb = youtubeThumb(vid);
    if (this._resolutionFor !== vid) {
      this._resolution = null;
      this._resolutionFor = null;
    }
    const guess =
      this._resolution || resolutionFromText(nowPlaying.title, nowPlaying.artist);
    if (guess) nowPlaying.resolution = guess;
    this.lastYoutubeId = vid;
    this.lastYoutubeTitleKey = titleKey;
    this.lastYoutubeTrackKey = trackKey(nowPlaying.title, nowPlaying.artist);
    this.titleToVideoId.set(this.lastYoutubeTrackKey, vid);
    this.#ensureSuggested(vid);
  }

  /** Title is published immediately. The video id fills in on a later broadcast. */
  #lookupYoutube(nowPlaying) {
    const key = trackKey(nowPlaying?.title, nowPlaying?.artist);
    if (!key || this._ytLookup === key) return;
    this._ytLookup = key;
    void this.#resolveYoutubeId(nowPlaying).then((vid) => {
      if (!vid) {
        setTimeout(() => {
          if (this._ytLookup === key) this._ytLookup = "";
        }, 15000);
        return;
      }
      if (this._ytLookup === key) this._ytLookup = "";
      const current = this.lastState?.nowPlaying;
      if (!current) return;
      if (trackKey(current.title, current.artist) !== key) return;
      if (current.videoId === vid) return;
      this.#stampYoutube(current, vid);
      if (current.playing && this.projector) this.#ensurePlaybackResolution(this.projector, vid);
      this.#noteHistoryFromNowPlaying(current);
      this.onPlayback?.(this.lastState);
    });
  }

  /**
   * The page renders this object as-is. A missing title for a few seconds
   * keeps the track already on screen instead of making every browser guess.
   */
  #rememberNowPlaying(nowPlaying) {
    const title = String(nowPlaying?.title || "").trim();
    const key = title.toLowerCase() === "null" ? "" : title.toLowerCase();
    const prev = this._shownPlaying;
    const prevKey = String(prev?.title || "").trim().toLowerCase();
    const now = Date.now();
    if (key) {
      if (prevKey && key !== prevKey && key === this._leftTitle && now - this._switchedAt < 6000) {
        return prev;
      }
      if (prevKey && key !== prevKey) {
        this._leftTitle = prevKey;
        this._switchedAt = now;
      }
      const same = key === prevKey;
      const settled = {
        ...nowPlaying,
        title,
        videoId: nowPlaying.videoId || (same ? prev?.videoId : null) || null,
        thumb: nowPlaying.thumb || (same ? prev?.thumb : null) || null,
        resolution: nowPlaying.resolution || (same ? prev?.resolution : null) || null,
        artist:
          nowPlaying.artist && String(nowPlaying.artist).toLowerCase() !== "null"
            ? nowPlaying.artist
            : same
              ? prev?.artist || ""
              : "",
      };
      this._shownPlaying = settled;
      this._shownAt = now;
      return settled;
    }
    if (prev && now - (this._shownAt || 0) < 8000) {
      const live = nowPlaying.playing || nowPlaying.paused;
      return {
        ...prev,
        playing: live ? nowPlaying.playing : prev.playing,
        paused: live ? nowPlaying.paused : prev.paused,
        state: live && nowPlaying.state && nowPlaying.state !== "NONE" ? nowPlaying.state : prev.state,
        positionMs: nowPlaying.positionMs ?? prev.positionMs,
        positionUpdatedMs: nowPlaying.positionUpdatedMs ?? prev.positionUpdatedMs,
      };
    }
    this._shownPlaying = null;
    return nowPlaying;
  }

  async #resolveYoutubeId(nowPlaying) {
    const title = nowPlaying?.title;
    const artist = nowPlaying?.artist;
    const key = trackKey(title, artist);
    if (!key) return null;
    if (this.titleToVideoId.has(key)) return this.titleToVideoId.get(key);
    const artistKey = String(artist || "").trim().toLowerCase();
    const titleKey = String(title || "").trim().toLowerCase();
    const query =
      artistKey && artistKey !== titleKey ? `${title} ${artist}` : title;
    try {
      const found = await searchYoutubeVideo(query, {
        title,
        artist,
        durationMs: nowPlaying?.durationMs,
      });
      this.titleToVideoId.set(key, found.videoId);
      this.lastYoutubeId = found.videoId;
      this.lastYoutubeTitleKey = titleKey;
      this.lastYoutubeTrackKey = key;
      console.log(`youtube ${title} / ${artist || "?"} -> ${found.videoId}`);
      return found.videoId;
    } catch {
      // Never return a stale id for a different title.
      return null;
    }
  }

  /**
   * Read the YouTube SurfaceView buffer size from SurfaceFlinger.
   * This is the resolution actually playing on the projector.
   */
  #ensurePlaybackResolution(p, videoId) {
    const id = String(videoId || "").trim();
    if (!id) return;
    if (this._resolutionFor === id && this._resolution) return;
    if (this._resolutionInflight) return;
    this._resolutionInflight = true;
    p.shell(
      "dumpsys SurfaceFlinger 2>/dev/null | grep -F 'youtube.tv' | grep -oE 'w/h:[0-9]+x[0-9]+' | head -1",
      5_000,
    )
      .then((raw) => {
        const match = /w\/h:(\d+)x(\d+)/.exec(String(raw || ""));
        if (!match) return;
        const label = resolutionFromSize(Number(match[1]), Number(match[2]));
        if (!label) return;
        this._resolution = label;
        this._resolutionFor = id;
        rememberResolution(id, label);
        if (this.lastState?.nowPlaying?.videoId === id) {
          this.lastState.nowPlaying.resolution = label;
          try {
            this.onPlayback?.(this.lastState);
          } catch {
            /* ignore */
          }
        }
        if (this._historyRecordedId === id) {
          void patchYoutubeHistoryItem(this.storagePath, id, {
            resolution: label,
          })
            .then((items) => {
              try {
                this.onHistory?.({ items: items.slice(0, 40) });
              } catch {
                /* ignore */
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {})
      .finally(() => {
        this._resolutionInflight = false;
      });
  }

  #ensureDuration(videoId, expectedTitle) {
    if (!videoId || this._durationInflight.has(videoId)) return;
    const titleKey = String(expectedTitle || "").trim().toLowerCase();
    if (
      this._sessionDurationMs > 0 &&
      this._sessionDurationFor === titleKey &&
      this._resolution &&
      this._durationFor === videoId
    ) {
      return;
    }
    if (this._durationMs && this._durationFor === videoId && this._resolution) return;
    this._durationInflight.add(videoId);
    youtubeVideoMeta(videoId, expectedTitle || null)
      .then((entry) => {
        if (!entry?.ms) return;
        if (
          expectedTitle &&
          this.lastState?.nowPlaying?.title &&
          !titlesCompatible(entry.title, expectedTitle) &&
          !titlesCompatible(entry.title, this.lastState.nowPlaying.title)
        ) {
          return;
        }
        const liveTitle = String(this.lastState?.nowPlaying?.title || "").trim().toLowerCase();
        if (this._sessionDurationMs > 0 && this._sessionDurationFor === liveTitle) {
          // Still apply resolution if we only had session duration.
        } else {
          this._durationMs = entry.ms;
        }
        this._durationFor = videoId;
        if (entry.resolution) this._resolution = entry.resolution;
        if (this.lastState?.nowPlaying) {
          if (entry.ms && !(this._sessionDurationMs > 0 && this._sessionDurationFor === liveTitle)) {
            this.lastState.nowPlaying.durationMs = entry.ms;
          }
          if (entry.resolution) this.lastState.nowPlaying.resolution = entry.resolution;
          try {
            this.onPlayback?.(this.lastState);
          } catch {
            /* ignore */
          }
        }
        if (entry.resolution && this._historyRecordedId === videoId) {
          void this.#recordHistoryAndBroadcast({
            id: videoId,
            title: entry.title || expectedTitle,
            resolution: entry.resolution,
            durationMs: entry.ms,
            length: this.#formatLength(entry.ms),
          });
        }
      })
      .finally(() => this._durationInflight.delete(videoId));
  }

  /**
   * Learn YouTube's updated-clock offset with one pause/play.
   * A fresh write has the smallest (elapsed - updated) gap.
   */
  async #syncPlaybackClock(p) {
    const raw = await p.shell(
      [
        "cmd media_session dispatch pause",
        "sleep 0.2",
        "dumpsys media_session | grep 'state=PlaybackState' | head -1",
        "dumpsys alarm | grep -m 1 nowELAPSED",
        "cmd media_session dispatch play",
      ].join("; "),
      12_000,
    );
    const state = /position=(\d+), buffered position=\d+, speed=[0-9.]+, updated=(\d+)/.exec(
      raw,
    );
    const elapsed = Number(/nowELAPSED=(\d+)/.exec(raw)?.[1]);
    if (!state || !Number.isFinite(elapsed)) return null;
    const positionMs = Number(state[1]);
    const updatedMs = Number(state[2]);
    const offset = elapsed - updatedMs;
    if (offset > 0) this._clockOffset = offset;
    return { positionMs, updatedMs, elapsed };
  }

  /**
   * Live position = last reported position + time since that report.
   * YouTube freezes the position field while playing; `updated` is on a
   * private clock. staleness = (elapsedRealtime - updated) - clockOffset.
   */
  #applyProgress(nowPlaying, elapsed) {
    const now = Date.now();
    const raw = nowPlaying.positionMs;
    const updated = nowPlaying.positionUpdatedMs;
    let pos = null;
    let synced = false;

    if (raw != null && updated != null && elapsed != null) {
      const gap = elapsed - updated;
      const titleKey = String(nowPlaying.title || "").trim().toLowerCase();
      // A new track keeps the previous session clock, so the old offset
      // flings the position to the end of the video. Start this track at
      // the raw timestamp instead.
      const titleChanged = !!titleKey && titleKey !== this._clockTitle;
      if (titleChanged) this._clockTitle = titleKey;
      if (
        gap > 0 &&
        (this._clockOffset == null ||
          titleChanged ||
          gap + 500 < this._clockOffset)
      ) {
        this._clockOffset = gap;
      }
      if (this._clockOffset != null) {
        const staleness = gap - this._clockOffset;
        pos = nowPlaying.playing ? raw + Math.max(0, staleness) : raw;
        synced = true;
      }
    }

    if (nowPlaying.videoId) this.#ensureDuration(nowPlaying.videoId, nowPlaying.title);

    const titleKey = String(nowPlaying.title || "").trim().toLowerCase();
    const dur =
      this._sessionDurationMs > 0 && this._sessionDurationFor === titleKey
        ? this._sessionDurationMs
        : this._durationMs;
    if (pos != null && dur > 0) pos = Math.min(dur, Math.max(0, pos));

    nowPlaying.positionMs = pos != null ? Math.round(pos) : null;
    nowPlaying.durationMs = dur || null;
    if (
      this._resolution &&
      (this._resolutionFor === nowPlaying.videoId ||
        this._durationFor === nowPlaying.videoId)
    ) {
      nowPlaying.resolution = this._resolution;
    } else if (!nowPlaying.resolution) {
      nowPlaying.resolution = resolutionFromText(
        nowPlaying.title,
        nowPlaying.artist,
      );
    }
    nowPlaying.progressAt = now;
    nowPlaying.progressSynced = synced && pos != null;
  }

  async setPower(on) {
    if (on) {
      void broadcastWake(projectorMac(), String(this.host || projectorLastIp() || "").split(":")[0]);
      await this.#wakeUntilReady();
      try {
        return await this.getState({ fresh: true });
      } catch {
        return this.lastState;
      }
    }
    return this.withProjector(async (p) => {
      await this.#runPower(p, "sleep");
      this.lastState = {
        ...(this.lastState || {}),
        ok: true,
        powerOn: false,
        screenOn: false,
        powerMode: "standby",
        error: null,
      };
      this.onPlayback?.(this.lastState);
      try {
        return await this.getState({ fresh: true });
      } catch {
        return this.lastState;
      }
    });
  }

  #isStandby() {
    const state = this.lastState;
    if (!state) return false;
    return (
      state.powerOn === false ||
      state.powerMode === "standby" ||
      state.powerMode === "off"
    );
  }

  /** Drop overlays the UI can get stuck on, then read the projector again. */
  async resetState() {
    this._seekGen += 1;
    this._seek = null;
    this._pendingBrightness = null;
    this._pendingBrightnessUntil = 0;
    this._pendingScreen = null;
    this._pendingScreenUntil = 0;
    this._pendingMuted = null;
    this._pendingMutedUntil = 0;
    this._volumeBeforeMute = null;
    this._muteVolumeTarget = null;
    this._pendingVolume = null;
    this._volumeToken += 1;
    this._starting = null;
    this._startingPrev = null;
    this._startedHold = null;
    this.#stopPlaybackWatch();
    this.powerProgress = null;
    this._chain = Promise.resolve();
    this._keyChain = Promise.resolve();
    this._navUntil = 0;
    this._queueDepth = 0;
    if (this.lastState?.nowPlaying) {
      this.lastState = {
        ...this.lastState,
        nowPlaying: {
          ...this.lastState.nowPlaying,
          starting: false,
          seeking: false,
        },
      };
    }
    try {
      this.onReset?.();
    } catch {
      // listeners must not break the reset
    }
    try {
      this.onPower?.({
        active: false,
        kind: null,
        title: "",
        steps: [],
        done: 0,
        total: 0,
        error: null,
      });
    } catch {
      // ignore
    }
    try {
      const state = await this.getState({ fresh: true });
      this.onPlayback?.(state);
      return state;
    } catch (error) {
      const missing = /ADB not found/i.test(error.message || "");
      const state = {
        ...(this.lastState || {}),
        ok: false,
        error: error.message,
        ...(missing
          ? { powerOn: false, powerMode: "standby", screenOn: false }
          : {}),
      };
      this.lastState = state;
      this.onPlayback?.(state);
      return state;
    }
  }

  async #waitForHost(limitMs) {
    const deadline = Date.now() + limitMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        await this.ensureHost();
        return this.host;
      } catch (error) {
        last = error;
        this.host = null;
        this.projector = null;
        await broadcastWake(projectorMac(), projectorLastIp());
        await sleep(1200);
      }
    }
    throw last || new Error("Projector did not answer");
  }

  /** Wake loader, then block until the projector is actually on. */
  async #wakeUntilReady() {
    return this.enqueue(async () => {
      const mac = projectorMac();
      const waiting = evaluatePower("wake", freshPowerSteps("wake"), null, {
        signalSent: true,
        linked: false,
      });
      this.#emitPower("wake", waiting, { active: true });
      try {
        await this.#waitForHost(120_000);
      } catch (error) {
        const steps = freshPowerSteps("wake");
        this.#emitPower("wake", steps, {
          active: false,
          error: error.message || "Projector did not answer",
        });
        throw error;
      }
      const projector = this.projector;
      if (!projector) {
        const missing = new Error("Projector did not answer");
        this.#emitPower("wake", freshPowerSteps("wake"), {
          active: false,
          error: missing.message,
        });
        throw missing;
      }
      if (!projector.wifiMac) projector.wifiMac = mac;
      const probe = await projector.wakeProbe().catch(() => null);
      if (probe?.awake && probe.displayOn && probe.led && probe.audio) {
        const steps = freshPowerSteps("wake").map((step) => ({
          ...step,
          status: "done",
        }));
        this.#emitPower("wake", steps, { active: false });
        this.#markAwake();
        return;
      }
      await this.#runPower(projector, "wake");
      this.#markAwake();
    });
  }

  #markAwake() {
    this.lastState = {
      ...(this.lastState || {}),
      ok: true,
      powerOn: true,
      powerMode: "on",
      screenOn: true,
      error: null,
    };
    this.onPlayback?.(this.lastState);
  }

  async shutdown() {
    return this.withProjector(async (p) => {
      await this.#runPower(p, "shutdown");
      this.lastState = {
        ...(this.lastState || {}),
        ok: true,
        powerOn: false,
        screenOn: false,
        powerMode: "off",
        error: null,
      };
      this.onPlayback?.(this.lastState);
      return this.lastState;
    });
  }

  async reboot() {
    return this.withProjector(async (p) => {
      await this.#runPower(p, "reboot");
      return this.getState({ fresh: true });
    });
  }

  async #ensureAwake(p) {
    const probe = await p.wakeProbe().catch(() => null);
    if (probe?.awake && probe.displayOn && probe.led && probe.audio) return;
    await this.#runPower(p, "wake");
  }

  #emitPower(kind, steps, extra) {
    this.powerProgress = powerSnapshot(kind, steps, extra);
    try {
      this.onPower?.(this.powerProgress);
    } catch {
      // listeners must not break the sequence
    }
  }

  async #runPower(p, kind) {
    const limit =
      kind === "reboot" ? 180_000 : kind === "wake" ? 120_000 : kind === "sleep" ? 45_000 : 40_000;
    const deadline = Date.now() + limit;
    let steps = freshPowerSteps(kind);
    const flags = {
      signalSent: false,
      commandSent: false,
      linked: false,
      sawOffline: false,
      offline: false,
      ready: false,
    };
    const publish = () => {
      steps = evaluatePower(kind, steps, flags.probe || null, flags);
      this.#emitPower(kind, steps, { active: true });
    };

    try {
      if (kind === "wake") {
        publish();
        await p.sendWake();
        flags.signalSent = true;
        publish();
      } else if (kind === "sleep") {
        publish();
        await p.setPower(false);
        flags.signalSent = true;
        publish();
      } else {
        publish();
        await p.powerCtl(kind === "reboot" ? "reboot" : "shutdown");
        flags.commandSent = true;
        publish();
      }

      while (Date.now() < deadline) {
        if (!flags.ready && kind === "wake" && !flags.probe?.awake) {
          await p.nudgeWake().catch(() => {});
          flags.signalSent = true;
        }
        try {
          flags.probe = await p.wakeProbe(kind === "sleep" ? 6_000 : 14_000);
          flags.linked = true;
        } catch {
          flags.probe = null;
          if (flags.linked || flags.commandSent || flags.signalSent) flags.sawOffline = true;
          flags.linked = false;
          flags.offline = true;
        }
        publish();
        const finished = steps.every((step) => step.status === "done");
        if (kind === "shutdown" && flags.offline && flags.commandSent) break;
        if (finished) break;
        const pendingReady = steps.find((step) => step.id === "ready" && step.status === "active");
        if (
          pendingReady &&
          flags.probe?.awake &&
          flags.probe.displayOn &&
          flags.probe.audio &&
          flags.probe.led &&
          !flags.probe.focusing
        ) {
          try {
            const state = await p.read();
            flags.ready = !!state?.powerOn;
          } catch {
            flags.ready = false;
          }
          publish();
          if (steps.every((step) => step.status === "done")) break;
        }
        await sleep(1000);
      }

      if (!steps.every((step) => step.status === "done")) {
        if (kind === "shutdown" && flags.offline) {
          // powered off is the goal
        } else {
          const current = steps.find((step) => step.status === "active");
          throw new Error(
            current
              ? `Stopped at “${current.label}”`
              : kind === "sleep"
                ? "Projector did not finish going to standby"
                : "Projector did not finish starting",
          );
        }
      }
      this.#emitPower(kind, steps, { active: false });
    } catch (error) {
      const failed = steps.map((step) =>
        step.status === "active" ? { ...step, status: "error", detail: error.message } : step,
      );
      this.#emitPower(kind, failed, { active: false, error: error.message });
      throw error;
    }
  }

  async setScreen(on) {
    this.#holdScreen(!!on);
    return this.withProjector(async (p) => {
      await p.setScreen(!!on);
      return this.getState({ fresh: true });
    });
  }

  /** Keep the screen switch where the user put it until the projector agrees. */
  #holdScreen(on) {
    this._pendingScreen = !!on;
    this._pendingScreenUntil = Date.now() + 6000;
    if (!this.lastState) return;
    this.lastState.screenOn = !!on;
    this.#publish();
  }

  #applyScreenHold(state) {
    if (this._pendingScreen == null) return state;
    if (state.screenOn === this._pendingScreen || Date.now() > this._pendingScreenUntil) {
      this._pendingScreen = null;
      return state;
    }
    return { ...state, screenOn: this._pendingScreen };
  }

  async setBrightness(level) {
    const n = Math.max(1, Math.min(11, Math.round(Number(level))));
    this.#holdBrightness(n);
    return this.withProjector(async (p) => {
      if (n >= 1 && n <= 11) await p.setBrightnessScale(n);
      else await p.setBrightness(n);
      return this.getState({ fresh: true });
    });
  }

  /** Keep the level the user set until the projector actually reports it. */
  #holdBrightness(scale) {
    const n = Math.max(1, Math.min(11, Math.round(Number(scale))));
    if (!Number.isFinite(n)) return;
    this._pendingBrightness = n;
    this._pendingBrightnessUntil = Date.now() + 4000;
    if (!this.lastState) return;
    this.lastState.brightnessScale = n;
    this.lastState.luminanceBoost = n >= 11;
    this.lastState.brightness = n >= 11 ? 10 : n;
    this.#publish();
  }

  #applyBrightnessHold(state) {
    const pending = this._pendingBrightness;
    if (pending == null) return state;
    const scale = state.luminanceBoost ? 11 : state.brightness;
    if (scale === pending || Date.now() > this._pendingBrightnessUntil) {
      this._pendingBrightness = null;
      return state;
    }
    return {
      ...state,
      brightness: pending >= 11 ? 10 : pending,
      luminanceBoost: pending >= 11,
    };
  }

  async setMuted(muted) {
    this.#holdMute(!!muted);
    return this.withProjector(async (p) => {
      await p.setMuted(!!muted);
      return this.getState({ fresh: true });
    });
  }

  /**
   * Mute drops the slider to zero immediately and remembers the level.
   * Unmute puts that level back. A stale poll cannot snap either one.
   */
  #holdMute(muted) {
    const on = !!muted;
    this._pendingMuted = on;
    this._pendingMutedUntil = Date.now() + 6000;
    if (!this.lastState) return;
    if (on) {
      if ((this.lastState.volume ?? 0) > 0) {
        this._volumeBeforeMute = this.lastState.volume;
      }
      this._muteVolumeTarget = 0;
      this.lastState.muted = true;
      this.lastState.volume = 0;
    } else {
      this._muteVolumeTarget = this._volumeBeforeMute ?? this.lastState.volume;
      this.lastState.muted = false;
      if (this._volumeBeforeMute != null) {
        this.lastState.volume = this._volumeBeforeMute;
      }
    }
    this.#publish();
  }

  #applyMuteHold(volume, muted) {
    if (this._pendingMuted == null) return { volume, muted };
    const expired = Date.now() > this._pendingMutedUntil;
    if (this._pendingMuted) {
      const arrived = muted === true && volume === 0;
      if (arrived || expired) {
        this._pendingMuted = null;
        this._muteVolumeTarget = null;
        return { volume, muted };
      }
      return { volume: 0, muted: true };
    }
    const target = this._muteVolumeTarget != null ? this._muteVolumeTarget : volume;
    const arrived = muted === false && volume === target;
    if (arrived || expired) {
      this._pendingMuted = null;
      this._muteVolumeTarget = null;
      if (muted === false) this._volumeBeforeMute = null;
      return { volume, muted };
    }
    return { volume: target, muted: false };
  }

  /**
   * Latest-wins volume. One setStreamVolume for the target — no keyevent walk.
   * A newer level requested mid-call replaces the result.
   */
  async setVolume(level) {
    const max = this.lastState?.volumeMax || this.projector?.volumeMax || 100;
    const next = Math.max(0, Math.min(max, Math.round(Number(level))));
    this._pendingVolume = next;
    this._volumeToken += 1;
    let unmute = !!(this.lastState?.muted || this._pendingMuted === true);
    this.#rememberVolume(next);
    if (this._volumeRunning) {
      return this.lastState || { ok: true, volume: next };
    }
    this._volumeRunning = true;
    try {
      await this.ensureHost();
      const p = this.projector;
      let guard = 0;
      while (this._pendingVolume != null && guard < 4) {
        guard += 1;
        const target = this._pendingVolume;
        const token = this._volumeToken;
        let volume;
        try {
          volume = await p.setVolumeDirect(target);
        } catch (error) {
          const text = `${error?.message ?? ""}`;
          if (/unable to connect|device offline|not found|timeout/i.test(text)) {
            invalidateAdbHost(this.host);
            this.host = null;
            this.projector = null;
            await this.ensureHost();
            continue;
          }
          throw error;
        }
        if (this._volumeToken !== token) continue;
        if (unmute) {
          await p.setMuted(false);
          unmute = false;
        }
        this.#rememberVolume(volume);
        if (volume !== target) {
          volume = await p.nudgeVolume(target - volume, {
            maxSteps: Math.min(max, Math.abs(target - volume)),
          });
          this.#rememberVolume(volume);
        }
        if (this._volumeToken === token && this._pendingVolume === target) {
          this._pendingVolume = null;
          break;
        }
      }
      return this.getState({ fresh: true });
    } finally {
      this._volumeRunning = false;
      if (this._pendingVolume != null) {
        return this.setVolume(this._pendingVolume);
      }
    }
  }

  async volumeDelta(delta) {
    const max = this.lastState?.volumeMax || this.projector?.volumeMax || 100;
    const cur =
      this._pendingVolume != null
        ? this._pendingVolume
        : (this.lastState?.volume ?? 0);
    const next = Math.max(0, Math.min(max, cur + Number(delta || 0)));
    return this.setVolume(next);
  }

  #emitKeyboard() {
    const open = !!this._searchOpen || !!this._imeShown;
    if (this.lastState) this.lastState.keyboardOpen = open;
    if (open === this._keyboardOpen) return;
    this._keyboardOpen = open;
    try {
      this.onKeyboard?.(open);
    } catch {
      // broadcast failures shouldn't stop the watcher
    }
  }

  #noteNavLine(line) {
    const match = /Navigated to (\S+)/.exec(line);
    if (!match) return;
    const url = match[1];
    const open = /#\/search(?:[?#/]|$)/.test(url);
    if (open !== this._searchOpen) {
      this._searchOpen = open;
      this.#emitKeyboard();
    }
    const id = /watch\?v=([A-Za-z0-9_-]{11})/.exec(url)?.[1];
    if (id) this.#applyNavigatedId(id);
  }

  #stopNavWatch() {
    const child = this._navChild;
    this._navChild = null;
    this._navHost = null;
    if (!child) return;
    child.kill("SIGTERM");
  }

  /** YouTube TV draws its own keyboard and never raises the Android IME. */
  #ensureNavWatch() {
    if (!this.host) return;
    if (this._navChild && this._navHost === this.host) return;
    this.#stopNavWatch();
    this._navHost = this.host;
    const child = spawn("adb", ["-s", this.host, "logcat", "-T", "1", "cobalt:I", "*:S"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    this._navChild = child;
    this._navBuf = "";
    child.stdout.on("data", (chunk) => {
      this._navBuf += chunk.toString();
      if (this._navBuf.length > 65536) {
        this._navBuf = this._navBuf.slice(-32768);
      }
      const lines = this._navBuf.split("\n");
      this._navBuf = lines.pop() || "";
      for (const line of lines) this.#noteNavLine(line);
    });
    child.on("exit", () => {
      if (this._navChild !== child) return;
      this._navChild = null;
      setTimeout(() => this.#ensureNavWatch(), 1000);
    });
  }

  /**
   * Fast check for a real Android soft keyboard. YouTube search is tracked
   * separately from Cobalt's navigation log.
   */
  async pollIme() {
    if (this._imeInflight) return this._imeInflight;
    const run = this.withProjector(async (p) => {
      this.#ensureNavWatch();
      const raw = await p.shell(
        "dumpsys input_method | grep -m 1 '^  mInputShown='; echo __XG_YT__; pidof com.google.android.youtube.tv",
        5_000,
      );
      const ime = /mInputShown=true/.test(raw.split("__XG_YT__")[0] || "");
      const youtubeUp = /\d/.test(raw.split("__XG_YT__")[1] || "");
      if (!youtubeUp && this._searchOpen) this._searchOpen = false;
      this._imeShown = ime;
      this.#emitKeyboard();
      return this._keyboardOpen;
    })
      .catch(() => this._keyboardOpen)
      .finally(() => {
        this._imeInflight = null;
      });
    this._imeInflight = run;
    return run;
  }

  /**
   * Type into the TV's open keyboard. `deletes` backspaces run first,
   * then `text` is inserted, then Enter if asked.
   */
  async typeOnTv({ text = "", deletes = 0, enter = false } = {}) {
    return this.withProjector(async (p) => {
      const n = Math.max(0, Math.min(40, Math.floor(Number(deletes) || 0)));
      if (n) {
        const keys = Array.from({ length: n }, () => 67).join(" ");
        await p.shell(`input keyboard keyevent ${keys}`);
      }
      const chunks = String(text).split(/\r?\n/).slice(0, 8);
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i].slice(0, 200);
        if (chunk) {
          const encoded = chunk.replace(/%/g, "%%").replace(/ /g, "%s");
          const quoted = `'${encoded.replace(/'/g, `'\\''`)}'`;
          await p.shell(`input keyboard text ${quoted}`);
        }
        if (i < chunks.length - 1) await p.shell("input keyboard keyevent 66");
      }
      if (enter) await p.shell("input keyboard keyevent 66");
      return { ok: true };
    });
  }

  /** True while direction keys are in flight, so the status poll stays out of the way. */
  navigating() {
    return Date.now() < this._navUntil;
  }

  /**
   * Direction keys stay off the status-poll queue. That poll holds the
   * projector for a few hundred milliseconds, and a left/right press was
   * waiting until it finished.
   */
  async sendKey(name) {
    this._navUntil = Date.now() + 700;
    const started = Date.now();
    const run = this._keyChain.then(async () => {
      const code = keyeventFor(name);
      await this.ensureHost();
      try {
        await this.projector.sendKey(code);
      } catch (error) {
        const text = `${error?.message ?? ""}`;
        if (!/unable to connect|device offline|not found|timeout/i.test(text)) throw error;
        invalidateAdbHost(this.host);
        this.host = null;
        this.projector = null;
        await this.ensureHost();
        await this.projector.sendKey(code);
      }
      const ms = Date.now() - started;
      if (ms > 150) console.log(`key ${name} ${ms}ms`);
      return { ok: true, key: name };
    });
    this._keyChain = run.catch(() => {});
    return run;
  }

  async media(action, seconds) {
    const a = String(action || "").toLowerCase();
    if (a === "seek" || a === "seek_to") {
      const spec = this.#beginSeek(a, seconds);
      if (!spec) throw new Error("Playback position isn't ready yet");
      return this.withProjector(async (p) => {
        try {
          const result = await this.#sessionSeekTo(p, spec.target, spec.gen);
          return { ok: true, action: a, method: "session", ...result };
        } catch (error) {
          this.#failSeek(spec.gen);
          throw error;
        }
      });
    }
    return this.withProjector(async (p) => {
      if (a === "play") {
        this.#patchPlayback({ playing: true, paused: false, state: "PLAYING" });
        await p.mediaDispatch("play");
        return { ok: true, action };
      }
      if (a === "pause") {
        this.#patchPlayback({ playing: false, paused: true, state: "PAUSED" });
        await p.mediaDispatch("pause");
        return { ok: true, action };
      }
      if (a === "stop") {
        this.#patchPlayback({ playing: false, paused: false, state: "NONE" });
        await p.mediaDispatch("stop");
        return { ok: true, action };
      }
      if (a === "play_pause" || a === "toggle") {
        const playing = !this.lastState?.nowPlaying?.playing;
        this.#patchPlayback({
          playing,
          paused: !playing,
          state: playing ? "PLAYING" : "PAUSED",
        });
        await p.mediaDispatch("play-pause");
        return { ok: true, action: "play_pause" };
      }
      throw new Error(`Unknown media action: ${action}`);
    });
  }

  async #ensureSeekJar(p) {
    if (this._seekJarReady) return;
    if (!fs.existsSync(SEEK_JAR)) throw new Error("Seek helper is missing");
    await p.push(SEEK_JAR, SEEK_REMOTE);
    this._seekJarReady = true;
  }

  /** Read duration from the media session (same metadata the phone and HA show). */
  async #refreshSessionDuration(p, title) {
    const titleKey = String(title || "").trim().toLowerCase();
    if (!titleKey || this._sessionDurationFor === titleKey) return;
    if (
      this._sessionDurationSkip === titleKey &&
      Date.now() < this._sessionDurationSkipUntil
    ) {
      return;
    }
    try {
      await this.#ensureSeekJar(p);
      const out = await p.shell(
        `CLASSPATH=${SEEK_REMOTE} app_process /system/bin com.xgimi.seek.SeekTo status`,
        12_000,
      );
      this.#rememberSessionDuration(out, titleKey);
      if (this._sessionDurationFor !== titleKey) {
        this._sessionDurationSkip = titleKey;
        this._sessionDurationSkipUntil = Date.now() + 4_000;
      }
    } catch {
      this._sessionDurationSkip = titleKey;
      this._sessionDurationSkipUntil = Date.now() + 4_000;
    }
  }

  #applyNavigatedId(id) {
    if (!id) return;
    this._pendingNav = id;
    clearTimeout(this._navTimer);
    this._navTimer = setTimeout(() => this.#commitNavigatedId(this._pendingNav), 150);
  }

  #commitNavigatedId(id) {
    if (!id) return;
    if (this.lastState?.nowPlaying?.videoId === id) {
      this._fastId = id;
      this.#ensureSuggested(id);
      return;
    }
    this._fastId = id;
    this._fastUntil = Date.now() + 12_000;
    const np = this.lastState?.nowPlaying;
    if (np) {
      const next = { ...np, videoId: id, thumb: youtubeThumb(id) };
      this.lastState = { ...this.lastState, nowPlaying: next };
      this._shownPlaying = next;
      this._shownAt = Date.now();
      this.onPlayback?.(this.lastState);
    }
    void this.#fillNavigatedMeta(id);
    this.#ensureSuggested(id);
  }

  async #fillNavigatedMeta(id) {
    const meta = await this.#oembed(id);
    if (!meta?.title || this._fastId !== id) return;
    this._fastTitle = meta.title;
    this._fastArtist = meta.author_name || "";
    this._fastUntil = Date.now() + 12_000;
    const prev = this.lastState?.nowPlaying;
    const next = {
      ...(prev || {}),
      title: meta.title,
      artist: this._fastArtist,
      videoId: id,
      thumb: youtubeThumb(id),
      package: prev?.package || "com.google.android.youtube.tv",
      playing: prev?.playing ?? true,
      paused: prev?.paused ?? false,
    };
    const prevTitle = String(prev?.title || "").trim().toLowerCase();
    if (prevTitle && prevTitle !== meta.title.trim().toLowerCase()) {
      this._leftTitle = prevTitle;
      this._switchedAt = Date.now();
    }
    const key = trackKey(next.title, next.artist);
    this.titleToVideoId.set(key, id);
    this._idFor = key;
    this.lastYoutubeId = id;
    this.lastYoutubeTitleKey = meta.title.trim().toLowerCase();
    this.lastYoutubeTrackKey = key;
    if (this.lastState) {
      this.lastState = { ...this.lastState, nowPlaying: next };
    }
    this._shownPlaying = next;
    this._shownAt = Date.now();
    this.#noteHistoryFromNowPlaying(next);
    this.onPlayback?.(this.lastState);
    console.log(`youtube id ${id} ${meta.title}`);
  }

  #suggestStill(id) {
    return this._fastId === id || this.lastState?.nowPlaying?.videoId === id;
  }

  #ensureSuggested(id) {
    if (!id || this._suggestedFor === id) return;
    this._suggestedFor = id;
    void this.#pushSuggested(id);
  }

  /** Suggestions are fetched here and pushed to every open page. */
  async #pushSuggested(id) {
    try {
      const page = await relatedYoutubeVideos(id);
      if (!this.#suggestStill(id)) return;
      let items = page.results || [];
      let continuation = page.continuation || "";
      this.suggested = { videoId: id, items, continuation };
      this.onSuggested?.(this.suggested);
      if (!continuation) return;
      const more = await relatedYoutubeVideos(id, continuation);
      if (!this.#suggestStill(id)) return;
      const seen = new Set(items.map((item) => item.id));
      items = items.concat(
        (more.results || []).filter((item) => item.id && !seen.has(item.id)),
      );
      this.suggested = {
        videoId: id,
        items,
        continuation: more.continuation || "",
      };
      this.onSuggested?.(this.suggested);
    } catch {
      /* the page keeps the previous list */
    }
  }

  /** Keep a just-navigated video on screen until the media session catches up. */
  #holdFastPlay(nowPlaying) {
    if (!this._fastId || Date.now() > this._fastUntil) return;
    if (this._fastTitle && titlesCompatible(nowPlaying.title, this._fastTitle)) {
      nowPlaying.videoId = this._fastId;
      nowPlaying.thumb = nowPlaying.thumb || youtubeThumb(this._fastId);
      const key = trackKey(this._fastTitle, this._fastArtist);
      this.titleToVideoId.set(key, this._fastId);
      this._idFor = key;
      this._fastId = "";
      return;
    }
    if (!this._fastTitle) {
      nowPlaying.videoId = this._fastId;
      nowPlaying.thumb = youtubeThumb(this._fastId);
      return;
    }
    nowPlaying.title = this._fastTitle;
    nowPlaying.artist = this._fastArtist;
    nowPlaying.videoId = this._fastId;
    nowPlaying.thumb = youtubeThumb(this._fastId);
  }

  /**
   * YouTube TV omits the video id from the media session, but Cobalt logs
   * the watch URL on every navigation. The title has to match before we
   * trust it, so a stale line cannot label the wrong song.
   */
  async #readCobaltVideoId(p) {
    const raw = await p.shell(
      "setprop log.tag.starboard S; logcat -d -s cobalt:I",
      5_000,
    );
    const matches = [...String(raw).matchAll(/watch\?v=([A-Za-z0-9_-]{11})/g)];
    return matches.length ? matches[matches.length - 1][1] : null;
  }

  async #oembed(id) {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    return res.json();
  }

  async #capturePlayingId(p, nowPlaying) {
    const key = trackKey(nowPlaying?.title, nowPlaying?.artist);
    if (!key || this._idFor === key || this._idInflight === key) return;
    if (this._idTryKey === key && Date.now() - this._idTryAt < 2_500) return;
    this._idInflight = key;
    this._idTryKey = key;
    this._idTryAt = Date.now();
    try {
      const id = await this.#readCobaltVideoId(p);
      if (!id || this._idMiss.get(key) === id) return;
      const meta = await this.#oembed(id);
      if (!titlesCompatible(meta?.title, nowPlaying.title)) {
        this._idMiss.set(key, id);
        return;
      }
      this._idFor = key;
      this.titleToVideoId.set(key, id);
      const current = this.lastState?.nowPlaying;
      if (!current || trackKey(current.title, current.artist) !== key) return;
      this.#stampYoutube(current, id);
      if (current.playing && this.projector) this.#ensurePlaybackResolution(this.projector, id);
      this.#noteHistoryFromNowPlaying(current);
      this.onPlayback?.(this.lastState);
      console.log(`youtube id ${id} ${meta.title}`);
    } catch {
      /* the next poll tries again */
    } finally {
      if (this._idInflight === key) this._idInflight = "";
    }
  }

  /**
   * YouTube TV does not put a video id on the session. It does attach the
   * picture for the video that is actually playing. Show that, instead of
   * searching by title.
   */
  async #refreshSessionPicture(p, nowPlaying) {
    const key = trackKey(nowPlaying?.title, nowPlaying?.artist);
    if (!key || this._artFor === key || this._artInflight === key) return;
    this._artInflight = key;
    try {
      await this.#ensureSeekJar(p);
      const out = await p.shell(
        `CLASSPATH=${SEEK_REMOTE} app_process /system/bin com.xgimi.seek.SeekTo status`,
        12_000,
      );
      if (!/ART_FILE/.test(out)) return;
      const bytes = await adbPullBytes(this.host, this.adbKey, "/data/local/tmp/now-playing.jpg");
      if (!bytes?.length) return;
      const file = path.join(this.storagePath, "now-playing.jpg");
      await fs.promises.writeFile(file, bytes);
      this._artFor = key;
      this._artGen = Date.now();
      const current = this.lastState?.nowPlaying;
      if (!current || trackKey(current.title, current.artist) !== key) return;
      if (current.videoId || this._starting?.videoId) return;
      current.thumb = `/api/now-playing.jpg?v=${this._artGen}`;
      this.onPlayback?.(this.lastState);
    } catch {
      /* the card still has the title if the picture cannot be read */
    } finally {
      if (this._artInflight === key) this._artInflight = "";
    }
  }

  nowPlayingArtFile() {
    const file = path.join(this.storagePath || ".", "now-playing.jpg");
    return fs.existsSync(file) ? file : null;
  }

  #rememberSessionDuration(output, titleKey) {
    const duration = Number(/duration=(-?\d+)/.exec(output)?.[1]);
    if (!(duration > 1000)) return false;
    const reported = / title=(.*)$/m.exec(output)?.[1]?.trim() || "";
    if (titleKey && reported && !titlesCompatible(reported, titleKey)) return false;
    this._sessionDurationMs = duration;
    this._sessionDurationFor = titleKey || reported.toLowerCase();
    this._durationMs = duration;
    this._durationFor = this._sessionDurationFor;
    return true;
  }

  /**
   * Absolute seek via MediaController.seekTo. This is the session command
   * the phone and Home Assistant send. It does not relaunch the video.
   */
  async #sessionSeekTo(p, positionMs, gen) {
    await this.#ensureSeekJar(p);
    let ms = Math.max(0, Math.round(Number(positionMs) || 0));
    if (this._sessionDurationMs > 0) {
      ms = Math.min(ms, Math.max(0, this._sessionDurationMs - 400));
    }
    const out = await p.shell(
      `CLASSPATH=${SEEK_REMOTE} app_process /system/bin com.xgimi.seek.SeekTo ${ms}`,
      15_000,
    );
    if (!/\bOK\b/.test(out)) {
      throw new Error((out || "seek failed").trim().slice(0, 300));
    }
    const titleKey = String(this.lastState?.nowPlaying?.title || "").trim().toLowerCase();
    this.#rememberSessionDuration(out, titleKey);
    const state = await p.shell(
      "dumpsys media_session | grep 'state=PlaybackState' | head -1",
      8_000,
    );
    if (/state=PAUSED/.test(state)) {
      await p.shell("cmd media_session dispatch play");
    }
    const landed = Number(/position=(\d+)/.exec(state)?.[1]);
    const landedMs = Number.isFinite(landed) ? landed : ms;
    this.#finishSeek(gen, landedMs);
    return {
      positionMs: landedMs,
      durationMs: this._sessionDurationMs || null,
    };
  }

  async listApps() {
    const apps = await this.withProjector(async (_p, host) => {
      const list = await listLeanbackApps(host, this.adbKey);
      warmAppIcons(host, this.adbKey, list, this.iconCache, this.staticIconDir);
      return list;
    });
    this.apps = apps || [];
    return this.apps;
  }

  async appIconPath(pkg) {
    return this.withProjector(async (_p, host) =>
      ensureAppIcon(host, this.adbKey, pkg, this.iconCache, this.staticIconDir),
    );
  }

  async launch(component, opts = {}) {
    return this.withProjector(async (_p, host) => {
      await launchApp(host, this.adbKey, component, opts);
      return { ok: true, component };
    });
  }

  #stopPlaybackWatch() {
    this._playWatchGen += 1;
    clearTimeout(this._playWatchTimer);
    this._playWatchTimer = null;
  }

  /**
   * The media-session title lands a few seconds after the picture and
   * sound. A new YouTube AudioTrack `event:started` is the playback itself.
   */
  #armPlaybackWatch(host, spec) {
    const gen = ++this._playWatchGen;
    clearTimeout(this._playWatchTimer);
    const armedAt = Date.now();
    const tick = async () => {
      if (this._playWatchGen !== gen) return;
      if (Date.now() - armedAt > 20_000) return;
      try {
        const audio = await adbShell(host, this.adbKey, "dumpsys audio", 4_000);
        if (this._playWatchGen !== gen) return;
        const line = latestYoutubeStart(audio);
        const stamp = startStamp(line);
        const piid = /player piid:(\d+) event:started/.exec(line || "")?.[1] || "";
        const prevPiid = /player piid:(\d+) event:started/.exec(spec.line || "")?.[1] || "";
        // A new movie track is a new player id. The same id restarting is
        // just the current video, which happens a few seconds before the
        // title changes and would drop the loader early.
        const fresh =
          !!piid &&
          piid !== prevPiid &&
          !!stamp &&
          !!spec.stamp &&
          stamp >= spec.stamp;
        if (fresh) {
          this.#publishPlaybackStart(spec, gen);
          return;
        }
      } catch {
        // keep polling until the title poll catches it
      }
      if (this._playWatchGen === gen) {
        this._playWatchTimer = setTimeout(tick, 250);
      }
    };
    this._playWatchTimer = setTimeout(tick, 200);
  }

  #publishPlaybackStart(spec, gen) {
    if (this._playWatchGen !== gen) return;
    this._playWatchGen += 1;
    clearTimeout(this._playWatchTimer);
    this._playWatchTimer = null;
    this._starting = null;
    this._startedHold = {
      title: spec.title || "",
      videoId: spec.videoId || "",
      until: Date.now() + 12000,
    };
    const prev = this.lastState?.nowPlaying || {};
    if (spec.videoId && this._durationFor !== spec.videoId) this._resolution = null;
    const nowPlaying = {
      ...prev,
      title: spec.title || prev.title,
      artist: "",
      package: "com.google.android.youtube.tv",
      playing: true,
      paused: false,
      state: "PLAYING",
      videoId: spec.videoId,
      thumb: spec.videoId ? youtubeThumb(spec.videoId) : prev.thumb,
      positionMs: 0,
      durationMs: spec.durationMs || prev.durationMs || null,
      resolution:
        (this._durationFor === spec.videoId && this._resolution) ||
        spec.resolution ||
        prev.resolution ||
        null,
      progressAt: Date.now(),
      progressSynced: true,
      starting: false,
    };
    const state = {
      ...(this.lastState || {}),
      nowPlaying,
      ok: true,
      error: null,
    };
    this.lastState = state;
    this.#noteSwitch(nowPlaying);
    // Forget the previous video's clock title so the next poll relearns
    // from this track instead of flinging the bar to the end.
    this._clockTitle = null;
    try {
      this.onPlayback?.(state);
    } catch {
      // broadcast failures shouldn't keep the loader up
    }
  }

  async youtubeSearch(q, signal) {
    return searchYoutubeSuggestions(q, 8, { signal });
  }

  async youtubeRelated(videoId, continuation = "") {
    return relatedYoutubeVideos(videoId, continuation);
  }

  async youtubeHistory({ limit = 40 } = {}) {
    const { attachResolutions } = await import("./youtube.mjs");
    const items = await listYoutubeHistory(this.storagePath, { limit });
    await attachResolutions(items, { concurrency: 3, limit: 12 });
    // Persist newly learned resolution without reordering.
    for (const row of items) {
      if (!row.resolution) continue;
      void patchYoutubeHistoryItem(this.storagePath, row.id, {
        resolution: row.resolution,
        durationMs: row.durationMs,
        length: row.length,
      }).catch(() => {});
    }
    return { items };
  }

  async youtubeStars({ limit = 40 } = {}) {
    const items = await listYoutubeStars(this.storagePath, { limit });
    return { items };
  }

  async starYoutube(item) {
    const { items } = await saveYoutubeStar(this.storagePath, item);
    try {
      this.onStars?.({ items: items.slice(0, 40) });
    } catch {
      /* ignore */
    }
    return { items: items.slice(0, 40) };
  }

  async unstarYoutube(id) {
    const { items } = await removeYoutubeStar(this.storagePath, id);
    try {
      this.onStars?.({ items: items.slice(0, 40) });
    } catch {
      /* ignore */
    }
    return { items: items.slice(0, 40) };
  }

  #formatLength(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return null;
    const total = Math.round(n / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  #noteHistoryFromNowPlaying(nowPlaying) {
    const id = String(nowPlaying?.videoId || "").trim();
    if (!id || !isYoutubePackage(nowPlaying?.package)) return;
    if (this._historyRecordedId === id) return;
    this._historyRecordedId = id;
    void this.#recordHistoryAndBroadcast({
      id,
      title: nowPlaying.title,
      channel: nowPlaying.artist,
      durationMs: nowPlaying.durationMs,
      length: this.#formatLength(nowPlaying.durationMs),
      resolution: nowPlaying.resolution || this._resolution,
      thumb: nowPlaying.thumb,
    });
  }

  async #recordHistoryAndBroadcast(item, { force = false } = {}) {
    try {
      if (item?.id && item.resolution) rememberResolution(item.id, item.resolution);
      const { items, changed } = await recordYoutubePlay(this.storagePath, item, {
        force,
      });
      if (!changed) return;
      try {
        this.onHistory?.({ items: items.slice(0, 40) });
      } catch {
        // broadcast failures shouldn't break playback
      }
    } catch {
      // history is best-effort
    }
  }

  /**
   * Focus a search/text field on the projector so phone typing has somewhere
   * to land. The web UI opens its own floating bar separately.
   */
  async openTypeOnTv() {
    return this.withProjector(async (p) => {
      try {
        await p.sendKey(keyeventFor("search"));
      } catch {
        // Typing can still target an already-focused field.
      }
      return { ok: true };
    });
  }

  #startingSnapshot(pending) {
    return {
      title: pending.title,
      artist: pending.artist || "",
      package: "com.google.android.youtube.tv",
      playing: false,
      paused: false,
      state: "BUFFERING",
      videoId: pending.videoId || null,
      thumb: pending.thumb || (pending.videoId ? youtubeThumb(pending.videoId) : null),
      positionMs: 0,
      durationMs: pending.durationMs ?? null,
      progressAt: null,
      progressSynced: true,
      starting: true,
    };
  }

  #noteSwitch(nowPlaying) {
    const prev = this._shownPlaying;
    const prevKey = String(prev?.title || "").trim().toLowerCase();
    const key = String(nowPlaying?.title || "").trim().toLowerCase();
    if (prevKey && key && prevKey !== key && !prev?.starting) {
      this._leftTitle = prevKey;
      this._switchedAt = Date.now();
    }
    this._shownPlaying = nowPlaying;
    this._shownAt = Date.now();
  }

  /** Every tab shows this card until the new video is actually playing. */
  #beginStarting(spec) {
    const prev = this.lastState?.nowPlaying;
    if (!this._starting) {
      this._startingPrev = prev && !prev.starting ? prev : this._startingPrev;
    }
    this._starting = {
      videoId: spec.videoId || "",
      title: spec.title || "Starting",
      artist: spec.artist || "",
      thumb: spec.thumb || (spec.videoId ? youtubeThumb(spec.videoId) : ""),
      durationMs: spec.durationMs ?? null,
      at: Date.now(),
    };
    const card = this.#startingSnapshot(this._starting);
    this.#noteSwitch(card);
    this.lastState = {
      ...(this.lastState || {}),
      nowPlaying: card,
      ok: true,
      error: null,
    };
    this.#publish();
  }

  #failStarting() {
    if (!this._starting) return;
    this._starting = null;
    const prev = this._startingPrev;
    this._startingPrev = null;
    if (!prev || !this.lastState) return;
    const nowPlaying = { ...prev, starting: false };
    this.lastState = { ...this.lastState, nowPlaying };
    this._shownPlaying = nowPlaying;
    this.#publish();
  }

  #playbackStarted(nowPlaying, pending) {
    if (!nowPlaying?.playing || nowPlaying.starting || !pending) return false;
    const titleOk = titlesShare(nowPlaying.title, pending.title);
    if (pending.videoId && nowPlaying.videoId && nowPlaying.videoId === pending.videoId) {
      return titleOk || !nowPlaying.title;
    }
    return titleOk;
  }

  #overlayStarting(nowPlaying) {
    const pending = this._starting;
    if (pending) {
      if (Date.now() - pending.at > 40000) {
        this._starting = null;
      } else if (this.#playbackStarted(nowPlaying, pending)) {
        this._starting = null;
        const playingId = nowPlaying.videoId || pending.videoId || null;
        return {
          ...nowPlaying,
          videoId: playingId,
          thumb: playingId ? youtubeThumb(playingId) : nowPlaying.thumb || pending.thumb || null,
          artist: nowPlaying.artist || pending.artist || "",
          durationMs: nowPlaying.durationMs || pending.durationMs || null,
          starting: false,
        };
      } else {
        return this.#startingSnapshot(pending);
      }
    }
    const hold = this._startedHold;
    if (!hold) return { ...nowPlaying, starting: false };
    if (Date.now() >= hold.until) {
      this._startedHold = null;
      return { ...nowPlaying, starting: false };
    }
    const arrived =
      (hold.videoId && nowPlaying.videoId === hold.videoId && titlesCompatible(nowPlaying.title, hold.title)) ||
      titlesCompatible(nowPlaying.title, hold.title);
    if (arrived) {
      this._startedHold = null;
      return { ...nowPlaying, starting: false };
    }
    if (this._shownPlaying && !this._shownPlaying.starting) {
      return { ...this._shownPlaying, starting: false };
    }
    return { ...nowPlaying, starting: false };
  }

  async youtubePlay({
    videoId,
    query,
    title: givenTitle,
    durationMs: givenDuration,
    length,
    channel,
  } = {}) {
    let id = videoId;
    let title = givenTitle || null;
    let durationMs =
      givenDuration != null
        ? Number(givenDuration)
        : parseLengthToMs(length) || null;
    const standby = this.#isStandby();
    if (standby) {
      void broadcastWake(projectorMac(), String(this.host || projectorLastIp() || "").split(":")[0]);
    }
    if (!id && query) {
      if (!standby) {
        this.#beginStarting({ title: query, videoId: "", artist: channel || "" });
      }
      try {
        const found = await searchYoutubeVideo(query);
        id = found.videoId;
        title = found.title;
        if (durationMs == null) durationMs = found.durationMs;
      } catch (error) {
        this.#failStarting();
        throw error;
      }
    }
    if (!id) {
      this.#failStarting();
      throw new Error("videoId or query required");
    }
    const spec = {
      videoId: id,
      title: title || query || id,
      artist: channel || "",
      durationMs,
      thumb: youtubeThumb(id),
    };
    if (!standby) this.#beginStarting(spec);

    try {
      if (standby) {
        await this.#wakeUntilReady();
        this.#beginStarting(spec);
      }
      return await this.#launchYoutube(id, title, durationMs, length, channel);
    } catch (error) {
      this.#failStarting();
      throw error;
    }
  }

  async #launchYoutube(id, title, durationMs, length, channel) {
    return this.withProjector(async (p, host) => {
      // Wake in parallel-ish: power then screen
      await this.#ensureAwake(p);
      try {
        await p.setScreen(true);
      } catch {
        // ignore
      }
      await sleep(1200);
      const [audio, stampRaw] = await Promise.all([
        adbShell(host, this.adbKey, "dumpsys audio", 5_000).catch(() => ""),
        adbShell(host, this.adbKey, "date '+%m-%d %H:%M:%S'", 4_000).catch(() => ""),
      ]);
      await adbShell(host, this.adbKey, youtubeLaunchCommand(id));
      this.#armPlaybackWatch(host, {
        videoId: id,
        title,
        durationMs,
        line: latestYoutubeStart(audio),
        stamp: String(stampRaw).trim(),
      });
      this.lastYoutubeId = id;
      this._launchId = id;
      this._launchTitle = title || "";
      this._launchUntil = Date.now() + 20_000;
      if (title) {
        const key = trackKey(title, channel);
        this.titleToVideoId.set(key, id);
        this.lastYoutubeTitleKey = String(title).trim().toLowerCase();
        this.lastYoutubeTrackKey = key;
      }
      if (durationMs) {
        this._durationMs = durationMs;
        this._durationFor = id;
      }
      this.#ensureDuration(id, title);
      this._historyRecordedId = id;
      void youtubeVideoMeta(id, title || null)
        .then((meta) => {
          if (meta?.resolution) {
            this._resolution = meta.resolution;
            this._durationFor = id;
            if (this.lastState?.nowPlaying?.videoId === id) {
              this.lastState.nowPlaying.resolution = meta.resolution;
              try {
                this.onPlayback?.(this.lastState);
              } catch {
                /* ignore */
              }
            }
          }
          return this.#recordHistoryAndBroadcast(
            {
              id,
              title: title || meta?.title,
              channel,
              length,
              durationMs: durationMs || meta?.ms,
              resolution: meta?.resolution || null,
            },
            { force: true },
          );
        })
        .catch(() =>
          this.#recordHistoryAndBroadcast(
            { id, title, channel, length, durationMs },
            { force: true },
          ),
        );
      return {
        ok: true,
        videoId: id,
        title,
        thumb: youtubeThumb(id),
        durationMs,
        host,
      };
    });
  }
}
