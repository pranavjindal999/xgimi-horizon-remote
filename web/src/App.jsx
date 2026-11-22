import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, onRemoteEvent } from "./api";
import { armPhoneVolume } from "./phoneVolume.js";
import DeviceSheet from "./DeviceSheet.jsx";
import SeekBar from "./SeekBar.jsx";
import SwipePad from "./SwipePad.jsx";
import ValueSlider from "./ValueSlider.jsx";
import {
  AppsIcon,
  BackIcon,
  ChevronIcon,
  HdmiIcon,
  HistoryIcon,
  StarIcon,
  KeyboardIcon,
  CloseIcon,
  SearchIcon,
  HomeIcon,
  LoaderIcon,
  MuteIcon,
  PauseIcon,
  PlayIcon,
  PowerIcon,
  ScreenIcon,
  SeekIcon,
  SunIcon,
  VolumeIcon,
} from "./icons.jsx";

const SEEK = [-15, -5, 5, 15];
const THEME_KEY = "xgimi-remote-theme";
const ACCENT_KEY = "xgimi-remote-accent";
const ACCENTS = [
  { id: "amber", label: "Amber" },
  { id: "blue", label: "Blue" },
  { id: "teal", label: "Teal" },
  { id: "green", label: "Green" },
  { id: "rose", label: "Rose" },
  { id: "violet", label: "Violet" },
];

/** Client-side HD probe when the server couldn't read YouTube formats. */
function probeThumbHd(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      img.onload = null;
      img.onerror = null;
      resolve(value);
    };
    img.onload = () => done(img.naturalWidth >= 1280 ? "HD" : null);
    img.onerror = () => done(null);
    img.src = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
    setTimeout(() => done(null), 4000);
  });
}

async function fillMissingResolutions(items) {
  const list = Array.isArray(items) ? items : [];
  const missing = list.filter((item) => item?.id && !item.resolution).slice(0, 24);
  if (!missing.length) return null;
  const updates = new Map();
  await Promise.all(
    missing.map(async (item) => {
      const label = await probeThumbHd(item.id);
      if (label) updates.set(item.id, label);
    }),
  );
  if (!updates.size) return null;
  return list.map((item) =>
    updates.has(item.id) && !item.resolution
      ? { ...item, resolution: updates.get(item.id) }
      : item,
  );
}

function trackTitle(nowPlaying) {
  const title = String(nowPlaying?.title || "").trim();
  if (!title || title.toLowerCase() === "null") return "";
  return title;
}

function titlesLoose(a, b) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function trackHasStarted(poll, pending) {
  if (!poll?.playing || !pending) return false;
  if (poll.videoId && pending.videoId && poll.videoId === pending.videoId) return true;
  return titlesLoose(trackTitle(poll), pending.title);
}

function startingCard(pending) {
  return {
    title: pending.title,
    artist: pending.artist || "",
    package: "com.google.android.youtube.tv",
    playing: false,
    paused: false,
    state: "BUFFERING",
    videoId: pending.videoId,
    thumb: pending.thumb,
    positionMs: 0,
    durationMs: pending.durationMs ?? null,
    progressAt: null,
    progressSynced: true,
    starting: true,
  };
}

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Keep the last list up while the query is still a refinement of it. */
function sameSearchFamily(shownFor, query) {
  const a = String(shownFor || "").trim().toLowerCase();
  const b = String(query || "").trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return short.length >= 2 && long.startsWith(short);
}

function useTheme() {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  });
  const [accent, setAccent] = useState(() => {
    const saved = localStorage.getItem(ACCENT_KEY);
    return ACCENTS.some((item) => item.id === saved) ? saved : "amber";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.setAttribute("data-accent", accent);
    localStorage.setItem(THEME_KEY, theme);
    localStorage.setItem(ACCENT_KEY, accent);
  }, [theme, accent]);

  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return { theme, toggle, accent, setAccent };
}

// Full-bleed tiles read larger than the logo, diamond, and triangle.
// Scales keep the artwork inside the tile on a phone.
const ICON_SCALE = {
  "com.google.android.youtube.tv": 1.15,
  "nl.giejay.android.tv.immich": 1.02,
  "com.stremio.one": 1.12,
  "org.jellyfin.androidtv": 0.92,
  "com.tailscale.ipn": 0.92,
  "com.android.tv.settings": 0.78,
  "com.android.vending": 0.96,
};

function projectorAsleep(state) {
  if (!state) return false;
  return (
    state.powerMode === "off" ||
    state.powerMode === "standby" ||
    state.powerOn === false
  );
}

function ytFrame(videoId) {
  const id = String(videoId || "").trim();
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";
}

function ytPoster(videoId) {
  const id = String(videoId || "").trim();
  return id ? `https://i.ytimg.com/vi/${id}/sddefault.jpg` : "";
}

function ytSharp(videoId) {
  const id = String(videoId || "").trim();
  return id ? `https://i.ytimg.com/vi/${id}/hq720.jpg` : "";
}

/** YouTube answers a missing hq720/maxres file with a 120px gray JPEG, often as HTTP 404. */
function isPlaceholderThumb(url) {
  return /\/(hq720|maxresdefault|sddefault)\.jpg(?:$|\?)/.test(String(url || ""));
}

function YtStill({ videoId, thumb, preferSharp = false }) {
  const frame =
    (!thumb || isPlaceholderThumb(thumb) ? ytFrame(videoId) : thumb) || ytFrame(videoId);
  const poster = ytPoster(videoId);
  const sharp = ytSharp(videoId);
  // hq720 is a real 16:9 picture with no bars. sddefault keeps black strips
  // that show up as lines once the card crops it.
  const first = (preferSharp && sharp) || poster || frame;
  const [src, setSrc] = useState(first);
  useEffect(() => {
    let cancel = false;
    setSrc(first);
    if (!preferSharp || !sharp || sharp === first) return undefined;
    const probe = new Image();
    probe.onload = () => {
      if (!cancel && probe.naturalWidth > 120) setSrc(sharp);
    };
    probe.src = sharp;
    return () => {
      cancel = true;
    };
  }, [first, sharp, preferSharp]);
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      onLoad={(e) => {
        const width = e.currentTarget.naturalWidth;
        if (!(width > 0 && width <= 120)) return;
        const next = src === sharp && poster ? poster : frame;
        if (next && src !== next) setSrc(next);
      }}
      onError={() => {
        const next = src === sharp && poster ? poster : frame;
        if (next && src !== next) setSrc(next);
      }}
    />
  );
}

function MediaRow({ item, starred, onPlay, onToggleStar, focused = false, onHover }) {
  return (
    <div className={`media-row ${focused ? "focused" : ""}`}>
      <button
        type="button"
        className="suggest-play"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPlay(item)}
        onMouseEnter={onHover}
      >
        <span className="thumb-wrap">
          <YtStill videoId={item.id} thumb={item.thumb} />
          {item.resolution ? (
            <span className="res-badge" aria-label={`Resolution ${item.resolution}`}>
              {item.resolution}
            </span>
          ) : null}
        </span>
        <div>
          <div className="t">{item.title}</div>
          <div className="s">{[item.channel, item.length].filter(Boolean).join(" · ")}</div>
        </div>
      </button>
        <button
          type="button"
        className={`star-btn ${starred ? "is-on" : ""}`}
        aria-pressed={starred}
        aria-label={starred ? "Unstar" : "Star"}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar(item);
        }}
      >
        <StarIcon filled={starred} />
        </button>
    </div>
  );
}

const MONO_ICONS = new Set(["com.tailscale.ipn", "com.android.tv.settings"]);

function AppIcon({ app }) {
  const [failed, setFailed] = useState(false);
  if (failed || !app.icon) {
    return <div className="app-icon fallback">{app.label?.[0] || "?"}</div>;
  }
  const scale = ICON_SCALE[app.package] ?? 0.9;
  if (MONO_ICONS.has(app.package)) {
    return (
      <div className="app-icon">
        <span
          className="app-mark"
          style={{
            transform: `scale(${scale})`,
            WebkitMaskImage: `url("${app.icon}")`,
            maskImage: `url("${app.icon}")`,
          }}
        />
      </div>
    );
  }
  return (
    <div className="app-icon">
      <img
        src={app.icon}
        alt=""
        loading="lazy"
        style={{ transform: `scale(${scale})` }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

export default function App() {
  const { theme, toggle: toggleTheme, accent, setAccent } = useTheme();
  const [state, setState] = useState(null);
  const [apps, setApps] = useState([]);
  const [linked, setLinked] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [resultsFor, setResultsFor] = useState("");
  const [searching, setSearching] = useState(false);
  const [openAc, setOpenAc] = useState(false);
  const [sugIndex, setSugIndex] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const searchRef = useRef(null);
  const holdRef = useRef(null);
  const stateRef = useRef(state);
  const queryRef = useRef(query);
  const searchSeqRef = useRef(0);
  const searchMemRef = useRef(new Map());
  const volumeCommitRef = useRef(null);
  const volumeHoldRef = useRef(null);
  const volumeBeforeMuteRef = useRef(null);
  const mutedHoldRef = useRef(null);
  const brightnessHoldRef = useRef(null);
  const screenHoldRef = useRef(null);
  const pendingPlayRef = useRef(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState(null);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [deviceError, setDeviceError] = useState("");
  const [deviceGen, setDeviceGen] = useState(0);
  const [resetting, setResetting] = useState(false);
  const [sources, setSources] = useState([
    { id: "apps", label: "Apps", active: false },
    { id: "hdmi1", label: "HDMI 1", active: false, connected: null },
    { id: "hdmi2", label: "HDMI 2", active: false, connected: null },
  ]);
  const [sourceBusy, setSourceBusy] = useState("");
  const [powerMenu, setPowerMenu] = useState(false);
  const powerSwitchRef = useRef(null);
  const [powerAsk, setPowerAsk] = useState("");
  const [powerProgress, setPowerProgress] = useState(null);
  const powerBusyRef = useRef(false);
  const startPowerRef = useRef(() => {});
  const [suggestItems, setSuggestItems] = useState([]);
  const [suggestFor, setSuggestFor] = useState("");
  const [suggestToken, setSuggestToken] = useState("");
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestMore, setSuggestMore] = useState(false);
  const suggestListRef = useRef(null);
  const suggestSentinelRef = useRef(null);
  const suggestTokenRef = useRef("");
  const suggestItemsRef = useRef([]);
  const suggestBusyRef = useRef(false);
  const suggestGenRef = useRef(0);
  const typeRef = useRef(null);
  const typeAckRef = useRef("");
  const typeDraftRef = useRef("");
  const typeBusyRef = useRef(false);
  const typeTimerRef = useRef(null);
  const typeEnterRef = useRef(false);
  const typeExtraDeletesRef = useRef(0);
  const keyboardWasOpen = useRef(false);
  const typeBarRef = useRef(null);
  const kbGenRef = useRef(0);
  const prevKbRef = useRef(false);
  const [typeDraft, setTypeDraft] = useState("");
  const [typeHiddenGen, setTypeHiddenGen] = useState(0);
  const [typeForced, setTypeForced] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [starsOpen, setStarsOpen] = useState(false);
  const [starItems, setStarItems] = useState([]);
  const [starsLoading, setStarsLoading] = useState(false);
  const [starsError, setStarsError] = useState("");
  const kbOpen = !!state?.keyboardOpen;
  if (kbOpen && !prevKbRef.current) kbGenRef.current += 1;
  prevKbRef.current = kbOpen;
  const typeVisible =
    typeForced || (kbOpen && typeHiddenGen !== kbGenRef.current);
  const debouncedQuery = useDebounced(query, 120);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const flushType = useCallback(() => {
    if (typeBusyRef.current) return;
    const next = typeDraftRef.current;
    const prev = typeAckRef.current;
    const enter = typeEnterRef.current;
    const extra = typeExtraDeletesRef.current;
    let i = 0;
    const limit = Math.min(prev.length, next.length);
    while (i < limit && prev[i] === next[i]) i += 1;
    const deletes = prev.length - i + extra;
    const text = next.slice(i);
    if (!deletes && !text && !enter) return;
    typeEnterRef.current = false;
    typeExtraDeletesRef.current = 0;
    typeBusyRef.current = true;
    typeAckRef.current = next;
    api
      .type({ deletes, text, enter })
      .catch((e) => {
        if (typeAckRef.current === next) typeAckRef.current = prev;
        if (enter) typeEnterRef.current = true;
        typeExtraDeletesRef.current += extra;
        setError(e.message);
      })
      .finally(() => {
        typeBusyRef.current = false;
        if (
          typeDraftRef.current !== typeAckRef.current ||
          typeEnterRef.current ||
          typeExtraDeletesRef.current
        ) {
          flushType();
        }
      });
  }, []);

  const queueType = useCallback(
    (value) => {
      typeDraftRef.current = value;
      clearTimeout(typeTimerRef.current);
      typeTimerRef.current = setTimeout(flushType, 30);
    },
    [flushType],
  );

  useLayoutEffect(() => {
    const open = !!state?.keyboardOpen;
    if (open && !keyboardWasOpen.current) {
      typeAckRef.current = "";
      typeDraftRef.current = "";
      setTypeDraft("");
      const el = typeRef.current;
      if (el) {
        el.focus();
        el.click();
      }
    }
    if (!open && keyboardWasOpen.current) {
      typeRef.current?.blur();
      typeAckRef.current = "";
      typeDraftRef.current = "";
      setTypeDraft("");
    }
    keyboardWasOpen.current = open;
  }, [state?.keyboardOpen]);

  useEffect(() => {
    if (!typeVisible) return undefined;
    const onPointer = (e) => {
      if (typeBarRef.current?.contains(e.target)) return;
      setTypeForced(false);
      setTypeHiddenGen(kbGenRef.current);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [typeVisible]);

  useEffect(() => {
    if (!powerMenu) return undefined;
    const onPointer = (e) => {
      if (powerSwitchRef.current?.contains(e.target)) return;
      setPowerMenu(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setPowerMenu(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [powerMenu]);

  useEffect(() => {
    if (!powerProgress) powerBusyRef.current = false;
    if (!powerProgress || powerProgress.active || powerProgress.error) return undefined;
    const timer = setTimeout(() => setPowerProgress(null), 900);
    return () => clearTimeout(timer);
  }, [powerProgress]);

  startPowerRef.current = (on) => {
    if (powerBusyRef.current) return;
    powerBusyRef.current = true;
    if (on) {
      setPowerProgress({
        active: true,
        kind: "wake",
        title: "Waking from standby",
        steps: [],
        done: 0,
        total: 7,
      });
      api.power(true).catch((err) => setError(err.message || "Could not wake"));
      return;
    }
    setPowerProgress({
      active: true,
      kind: "sleep",
      title: "Going to standby",
      steps: [],
      done: 0,
      total: 6,
    });
    patchState({ powerOn: false, screenOn: false, powerMode: "standby" });
    api.power(false).catch((err) => setError(err.message || "Could not sleep"));
  };

  const openTypeOnTv = useCallback(() => {
    setTypeForced(true);
    setTypeHiddenGen(-1);
    typeAckRef.current = "";
    typeDraftRef.current = "";
    setTypeDraft("");
    api.typeOpen().catch((e) => setError(e.message));
    requestAnimationFrame(() => {
      const el = typeRef.current;
      if (!el) return;
      el.focus();
      el.click();
    });
  }, []);

  useEffect(() => {
    api.connect();
    return onRemoteEvent((event, data) => {
      if (event === "open") setLinked(true);
      if (event === "hello") {
        setLinked(true);
        if (data?.power?.active) setPowerProgress(data.power);
      }
      if (event === "power") setPowerProgress(data || null);
      if (event === "suggested" && data?.videoId) {
        setSuggestItems(Array.isArray(data.items) ? data.items : []);
        setSuggestToken(data.continuation || "");
        setSuggestFor(data.videoId);
        setSuggestLoading(false);
      }
      if (event === "reset") {
        volumeHoldRef.current = null;
        mutedHoldRef.current = null;
        brightnessHoldRef.current = null;
        screenHoldRef.current = null;
        pendingPlayRef.current = null;
        powerBusyRef.current = false;
        setPowerProgress(null);
        setError("");
      }
      if (event === "close") setLinked(false);
      if (event === "history") {
        setHistoryItems(Array.isArray(data?.items) ? data.items : []);
        setHistoryLoading(false);
        setHistoryError("");
      }
      if (event === "stars") {
        setStarItems(Array.isArray(data?.items) ? data.items : []);
        setStarsLoading(false);
        setStarsError("");
      }
      if (event === "keyboard") {
        setState((prev) =>
          prev
            ? { ...prev, keyboardOpen: !!data?.open }
            : { keyboardOpen: !!data?.open },
        );
      }
      if (event === "state") {
        // Keep a known YouTube thumb/videoId when the poll omits them for the same title.
        // While a seek is in flight, ignore a position that is still the pre-seek time.
        setState((prev) => {
          let next = data;
          if (next && next.powerOn == null && prev && "powerOn" in prev) {
            next = { ...next, powerOn: prev.powerOn };
          }
          if (
            volumeHoldRef.current != null &&
            next?.volume != null &&
            next.volume !== volumeHoldRef.current
          ) {
            next = { ...next, volume: volumeHoldRef.current };
          } else if (
            volumeHoldRef.current != null &&
            next?.volume === volumeHoldRef.current
          ) {
            volumeHoldRef.current = null;
          }
          if (mutedHoldRef.current != null && next) {
            const want = mutedHoldRef.current;
            if (!!next.muted !== want) {
              next = { ...next, muted: want, ...(want ? { volume: 0 } : {}) };
            } else {
              mutedHoldRef.current = null;
            }
          }
          if (brightnessHoldRef.current != null && next) {
            const scale =
              next.brightnessScale ?? (next.luminanceBoost ? 11 : next.brightness);
            if (scale !== brightnessHoldRef.current) {
              const level = brightnessHoldRef.current;
              next = {
                ...next,
                brightnessScale: level,
                luminanceBoost: level >= 11,
                brightness: Math.min(10, level),
              };
            } else {
              brightnessHoldRef.current = null;
            }
          }
          if (screenHoldRef.current != null && next) {
            if (!!next.screenOn !== screenHoldRef.current) {
              next = { ...next, screenOn: screenHoldRef.current };
            } else {
              screenHoldRef.current = null;
            }
          }
          const prevNp = prev?.nowPlaying;
          const nextNp = next?.nowPlaying;
          const sameArtist =
            !prevNp?.artist ||
            !nextNp?.artist ||
            prevNp.artist.trim().toLowerCase() === nextNp.artist.trim().toLowerCase();
          if (
            prevNp?.videoId &&
            nextNp &&
            !nextNp.videoId &&
            prevNp.title &&
            nextNp.title &&
            prevNp.title === nextNp.title &&
            sameArtist &&
            !nextNp.thumb
          ) {
            next = {
              ...next,
              nowPlaying: {
                ...nextNp,
                videoId: prevNp.videoId,
                thumb: prevNp.thumb || nextNp.thumb,
                resolution: nextNp.resolution || prevNp.resolution,
              },
            };
          } else if (
            prevNp?.resolution &&
            nextNp &&
            !nextNp.resolution &&
            prevNp.videoId &&
            nextNp.videoId === prevNp.videoId
          ) {
            next = {
              ...next,
              nowPlaying: { ...nextNp, resolution: prevNp.resolution },
            };
          }
          const held = next?.nowPlaying;
          if (
            !held?.seeking &&
            prevNp?.progressAt &&
            held &&
            prevNp.title &&
            held.title === prevNp.title &&
            prevNp.durationMs > 0 &&
            prevNp.positionMs < prevNp.durationMs * 0.9 &&
            held.positionMs != null &&
            held.positionMs > prevNp.durationMs - 2000
          ) {
            next = {
              ...next,
              nowPlaying: {
                ...held,
                positionMs: prevNp.positionMs,
                progressAt: prevNp.progressAt,
                progressSynced: prevNp.progressSynced,
              },
            };
          }
          const pending = pendingPlayRef.current;
          if (pending && Date.now() - pending.at > 40000) {
            pendingPlayRef.current = null;
          } else if (pending) {
            const poll = next?.nowPlaying;
            if (pending.afterWake && projectorAsleep(next)) {
              // Wake loader is up. The starting card waits until the projector is on.
            } else if (trackHasStarted(poll, pending)) {
              pendingPlayRef.current = null;
              next = {
                ...next,
                nowPlaying: {
                  ...poll,
                  videoId: poll.videoId || pending.videoId,
                  thumb: poll.thumb || pending.thumb,
                  artist: poll.artist || pending.artist || "",
                  starting: false,
                },
              };
            } else {
              if (pending.afterWake) pending.afterWake = false;
              next = { ...next, nowPlaying: startingCard(pending) };
            }
          }
          return next;
        });
      }
      if (event === "apps") setApps(data || []);
      if (event === "sources" && Array.isArray(data) && data.length) setSources(data);
      if (event === "device" && data) {
        setDeviceInfo(data);
        setDeviceLoading(false);
        setDeviceError("");
      }
    });
  }, []);

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q) {
      searchSeqRef.current += 1;
      setResults([]);
      setResultsFor("");
      setSearching(false);
      return undefined;
    }

    const seq = ++searchSeqRef.current;
    const remembered = searchMemRef.current.get(q.toLowerCase());
    if (remembered && Date.now() - remembered.at < 10 * 60 * 1000) {
      setResults(remembered.results);
      setResultsFor(q);
      setSugIndex(0);
      setSearching(false);
      if (document.activeElement === searchRef.current) setOpenAc(true);
      return undefined;
    }
    setSearching(true);

    (async () => {
      try {
        const r = await api.youtubeSearch(q);
        // Drop stale responses — only the latest typed query may win.
        if (seq !== searchSeqRef.current) return;
        if (q !== queryRef.current.trim()) return;
        const first = r.results || [];
        if (first.length) {
          searchMemRef.current.set(q.toLowerCase(), { at: Date.now(), results: first });
        }
        setResults(first);
        setResultsFor(q);
        setSugIndex(0);
        setSearching(false);
        if (document.activeElement === searchRef.current) {
          setOpenAc(true);
        }
        const filled = await fillMissingResolutions(first);
        if (seq !== searchSeqRef.current || !filled) return;
        if (q !== queryRef.current.trim()) return;
        searchMemRef.current.set(q.toLowerCase(), { at: Date.now(), results: filled });
        setResults(filled);
      } catch (e) {
        if (seq !== searchSeqRef.current) return;
        if (q !== queryRef.current.trim()) return;
        setSearching(false);
        setError(e.message);
      }
    })();

    return undefined;
  }, [debouncedQuery]);

  useEffect(() => {
    suggestTokenRef.current = suggestToken;
  }, [suggestToken]);

  useEffect(() => {
    suggestItemsRef.current = suggestItems;
  }, [suggestItems]);

  useEffect(() => {
    const id = state?.nowPlaying?.videoId;
    if (!id || suggestFor === id) return undefined;
    setSuggestLoading(true);
    setSuggestItems([]);
    setSuggestToken("");
    return undefined;
  }, [state?.nowPlaying?.videoId, suggestFor]);

  const loadMoreSuggestions = useCallback(() => {
    const token = suggestTokenRef.current;
    const id = state?.nowPlaying?.videoId;
    if (!token || !id || suggestBusyRef.current) return;
    const gen = suggestGenRef.current;
    suggestBusyRef.current = true;
    setSuggestMore(true);
    api
      .youtubeRelated(id, token)
      .then((r) => {
        if (suggestGenRef.current !== gen) return;
        const incoming = r.results || [];
        const seen = new Set(suggestItemsRef.current.map((item) => item.id));
        const extra = incoming.filter((item) => item.id && !seen.has(item.id));
        if (!extra.length) {
          setSuggestToken("");
          return;
        }
        setSuggestItems(suggestItemsRef.current.concat(extra));
        setSuggestToken(r.continuation || "");
        void fillMissingResolutions(extra).then((filledExtra) => {
          if (suggestGenRef.current !== gen || !filledExtra) return;
          const map = new Map(
            filledExtra.map((item) => [item.id, item.resolution]),
          );
          setSuggestItems((prev) =>
            prev.map((item) =>
              map.get(item.id) && !item.resolution
                ? { ...item, resolution: map.get(item.id) }
                : item,
            ),
          );
        });
      })
      .catch((e) => {
        if (suggestGenRef.current === gen) setError(e.message);
      })
      .finally(() => {
        suggestBusyRef.current = false;
        if (suggestGenRef.current === gen) setSuggestMore(false);
      });
  }, [state?.nowPlaying?.videoId]);

  useEffect(() => {
    const root = suggestListRef.current;
    const target = suggestSentinelRef.current;
    if (!suggestOpen || !root || !target || !suggestToken) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreSuggestions();
      },
      { root, rootMargin: "240px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [suggestOpen, suggestToken, suggestItems.length, loadMoreSuggestions]);

  const patchState = useCallback((partial) => {
    setState((s) => (s ? { ...s, ...partial } : { ...partial }));
  }, []);

  const previewVolume = useCallback(
    (level) => {
      volumeHoldRef.current = level;
      const wasMuted = !!stateRef.current?.muted || mutedHoldRef.current === true;
      if (wasMuted) mutedHoldRef.current = false;
      patchState(wasMuted ? { volume: level, muted: false } : { volume: level });
    },
    [patchState],
  );

  const commitVolume = useCallback(
    (level) => {
      const max = stateRef.current?.volumeMax || 100;
      const next = Math.max(0, Math.min(max, Math.round(Number(level))));
      const wasMuted = !!stateRef.current?.muted || mutedHoldRef.current === true;
      volumeHoldRef.current = next;
      if (wasMuted) {
        mutedHoldRef.current = false;
        volumeBeforeMuteRef.current = null;
      }
      patchState(wasMuted ? { volume: next, muted: false } : { volume: next });
      clearTimeout(volumeCommitRef.current);
      // Coalesce rapid +/- taps; slider only commits on release.
      volumeCommitRef.current = setTimeout(() => {
        api
          .volume({ level: next })
          .then((res) => {
            if (volumeHoldRef.current !== next) return;
            volumeHoldRef.current = null;
            if (res?.volume != null) patchState({ volume: res.volume });
          })
          .catch((e) => {
            if (volumeHoldRef.current === next) volumeHoldRef.current = null;
            setError(e.message);
          });
      }, 30);
    },
    [patchState],
  );

  useEffect(() => {
    // Hardware volume keys almost never reach a web page on phones.
    // Keep a capture listener for desktop / rare WebViews only.
    return armPhoneVolume((dir) => {
      if (projectorAsleep(stateRef.current)) return;
      const s = stateRef.current;
      const max = s?.volumeMax || 100;
      const base = volumeHoldRef.current ?? s?.volume ?? 0;
      commitVolume(Math.max(0, Math.min(max, base + dir)));
    });
  }, [commitVolume]);

  const run = useCallback(async (label, fn, { refresh = false } = {}) => {
    setStatus(label);
    setError("");
    try {
      await fn();
      if (refresh) {
        const s = await api.state();
        setState(s);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setStatus("");
    }
  }, []);

  const sendKey = useCallback((key) => {
    api.key(key).catch((e) => setError(e.message));
  }, []);

  const media = useCallback(
    (action, seconds) =>
      run(action, () => api.media(action, seconds), { refresh: false }),
    [run],
  );

  const requestSeek = useCallback((spec) => {
    const action = spec.absoluteSec != null ? "seek_to" : "seek";
    const seconds =
      spec.absoluteSec != null ? Math.round(spec.absoluteSec) : Math.round(spec.deltaSec);
    setError("");
    api.media(action, seconds).catch((e) => setError(e.message));
  }, []);

  const playVideo = useCallback(
    (item) => {
      setOpenAc(false);
      setSuggestOpen(false);
      setHistoryOpen(false);
      setStarsOpen(false);
      setResults([]);
      setResultsFor("");
      setSearching(false);
      searchSeqRef.current += 1;
      setQuery(item.title || "");
      searchRef.current?.blur();
      const durationMs =
        item.durationMs != null && Number.isFinite(Number(item.durationMs))
          ? Number(item.durationMs)
          : (() => {
              if (!item.length) return null;
              const parts = String(item.length)
                .trim()
                .split(":")
                .map((p) => Number(p));
              if (parts.some((n) => Number.isNaN(n))) return null;
              if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
              if (parts.length === 3) {
                return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
              }
              return null;
            })();
      const asleepNow = projectorAsleep(stateRef.current);
      const pending = {
        videoId: item.id,
        title: item.title,
        artist: item.channel,
        thumb: item.thumb,
        durationMs,
        at: Date.now(),
        afterWake: asleepNow,
      };
      pendingPlayRef.current = pending;
      if (asleepNow) {
        powerBusyRef.current = true;
        setPowerProgress({
          active: true,
          kind: "wake",
          title: "Waking from standby",
          steps: [],
          done: 0,
          total: 7,
        });
      } else {
        patchState({ nowPlaying: startingCard(pending) });
      }
      return run(`play`, async () => {
        try {
          await api.youtubePlay({
            videoId: item.id,
            title: item.title,
            length: item.length,
            durationMs,
            channel: item.channel,
          });
        } catch (e) {
          if (pendingPlayRef.current?.videoId === item.id) {
            pendingPlayRef.current = null;
          }
          if (asleepNow) {
            setPowerProgress((current) =>
              current
                ? { ...current, active: false, error: e.message || "Could not wake" }
                : current,
            );
          }
          throw e;
        }
      });
    },
    [patchState, run],
  );

  const playQuery = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    if (resultsFor === q && results[sugIndex]) {
      return playVideo(results[sugIndex]);
    }
    setOpenAc(false);
    if (projectorAsleep(stateRef.current)) {
      powerBusyRef.current = true;
      setPowerProgress({
        active: true,
        kind: "wake",
        title: "Waking from standby",
        steps: [],
        done: 0,
        total: 7,
      });
    }
    return run(`play`, () =>
      api.youtubePlay({ query: q }).catch((e) => {
        setPowerProgress((current) =>
          current && current.kind === "wake"
            ? { ...current, active: false, error: e.message || "Could not wake" }
            : current,
        );
        throw e;
      }),
    );
  }, [playVideo, query, results, resultsFor, run, sugIndex]);

  const launchApp = useCallback(
    (app) =>
      run(`launch ${app.label}`, () =>
        api.launch(app.component, !!app.launchByPackage),
      ),
    [run],
  );

  const brightnessValue = state?.brightnessScale ?? state?.brightness ?? 5;
  const np = state?.nowPlaying;

  useEffect(() => {
    const stopHold = () => {
      const hold = holdRef.current;
      if (!hold) return;
      clearTimeout(hold.delay);
      clearInterval(hold.repeat);
      holdRef.current = null;
    };
    const startHold = (fn) => {
      stopHold();
      fn();
      // A tap is one step. Repeats start only after the key is actually held.
      const delay = setTimeout(() => {
        if (holdRef.current?.delay !== delay) return;
        holdRef.current.repeat = setInterval(fn, 160);
      }, 420);
      holdRef.current = { delay, repeat: null };
    };

    const onKeyDown = (e) => {
      if (e.metaKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === "Escape") {
        if (kbOpen && typeHiddenGen !== kbGenRef.current) {
          setTypeHiddenGen(kbGenRef.current);
          e.preventDefault();
          return;
        }
        if (deviceOpen) {
          setDeviceOpen(false);
          e.preventDefault();
          return;
        }
        if (suggestOpen) {
          setSuggestOpen(false);
          e.preventDefault();
          return;
        }
        if (document.activeElement === searchRef.current) {
          if (openAc) setOpenAc(false);
          else if (query) {
            setQuery("");
            setResults([]);
          } else {
            searchRef.current.blur();
          }
          e.preventDefault();
          return;
        }
        if (!projectorAsleep(stateRef.current)) sendKey("back");
        e.preventDefault();
        return;
      }

      const inInput = document.activeElement?.tagName === "INPUT";
      if (inInput && !e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
        const liveResults =
          resultsFor === query.trim() && results.length > 0;
        if (e.key === "ArrowDown" && liveResults) {
          e.preventDefault();
          setOpenAc(true);
          setSugIndex((i) => Math.min(results.length - 1, i + 1));
          return;
        }
        if (e.key === "ArrowUp" && liveResults) {
          e.preventDefault();
          setSugIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          playQuery();
        }
        return;
      }

      if (projectorAsleep(stateRef.current)) return;

      if (e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        if (e.repeat) return;
        const dir = e.key === "ArrowUp" ? 1 : -1;
        startHold(() => {
          const cur = stateRef.current;
          const max = cur?.volumeMax || 100;
          const base = volumeHoldRef.current ?? cur?.volume ?? 0;
          commitVolume(Math.max(0, Math.min(max, base + dir)));
        });
        return;
      }

      if (
        e.shiftKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.ctrlKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown")
      ) {
        e.preventDefault();
        const s = stateRef.current;
        const base =
          brightnessHoldRef.current ?? s?.brightnessScale ?? s?.brightness ?? 5;
        const next =
          e.key === "ArrowUp" ? Math.min(11, base + 1) : Math.max(1, base - 1);
        brightnessHoldRef.current = next;
        patchState({
          brightnessScale: next,
          luminanceBoost: next >= 11,
          brightness: Math.min(10, next),
        });
        api.brightness(next);
        return;
      }

      if (
        e.repeat &&
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)
      ) {
        e.preventDefault();
        return;
      }

      if (
        (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) &&
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)
      ) {
        return;
      }

      const s = stateRef.current;
      const mute = () => {
        const on = !(mutedHoldRef.current ?? s?.muted);
        if (on) {
          const level = volumeHoldRef.current ?? s?.volume ?? 0;
          if (level > 0) volumeBeforeMuteRef.current = level;
          volumeHoldRef.current = 0;
          mutedHoldRef.current = true;
          patchState({ muted: true, volume: 0 });
        } else {
          const restore = volumeBeforeMuteRef.current ?? s?.volume ?? 0;
          volumeHoldRef.current = restore;
          mutedHoldRef.current = false;
          patchState({ muted: false, volume: restore });
        }
        api.mute(on);
      };
      const map = {
        ArrowUp: () => startHold(() => sendKey("up")),
        ArrowDown: () => startHold(() => sendKey("down")),
        ArrowLeft: () => startHold(() => sendKey("left")),
        ArrowRight: () => startHold(() => sendKey("right")),
        Enter: () => sendKey("ok"),
        " ": () => media("play_pause"),
        Backspace: () => sendKey("back"),
        m: mute,
        M: mute,
      };
      const handler = map[e.key];
      if (handler) {
        e.preventDefault();
        handler();
      }
    };

    const onKeyUp = (e) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        stopHold();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", stopHold);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", stopHold);
      stopHold();
    };
  }, [
    media,
    kbOpen,
    typeHiddenGen,
    deviceOpen,
    suggestOpen,
    openAc,
    patchState,
    commitVolume,
    playQuery,
    query,
    results,
    sendKey,
  ]);

  useEffect(() => {
    if (!deviceOpen) return undefined;
    if (deviceGen === 0 && deviceInfo) return undefined;
    let cancel = false;
    setDeviceLoading(true);
    setDeviceError("");
    api
      .device(deviceGen > 0)
      .then((info) => {
        if (cancel) return;
        setDeviceInfo(info);
        setDeviceLoading(false);
      })
      .catch((err) => {
        if (cancel) return;
        setDeviceError(err?.message || "Could not read the projector");
        setDeviceLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [deviceOpen, deviceGen]);

  const selectSource = (id) => {
    if (sourceBusy || sources.find((item) => item.id === id)?.active) return;
    setSourceBusy(id);
    setSources((list) => list.map((item) => ({ ...item, active: item.id === id })));
    api
      .source(id)
      .then((data) => {
        if (data?.sources?.length) setSources(data.sources);
      })
      .catch((err) => setError(err?.message || "Could not switch source"))
      .finally(() => setSourceBusy(""));
  };

  const starredIds = new Set(starItems.map((item) => item.id));
  const toggleStar = (item) => {
    const id = String(item?.id || item?.videoId || "").trim();
    if (!id) return;
    const payload = {
      id,
      title: item.title || "",
      channel: item.channel || item.artist || "",
      length: item.length || "",
      durationMs: item.durationMs,
      resolution: item.resolution || "",
      thumb: item.thumb || "",
    };
    const removing = starredIds.has(id);
    const previous = starItems;
    setStarItems((rows) =>
      removing
        ? rows.filter((row) => row.id !== id)
        : [{ ...payload }, ...rows.filter((row) => row.id !== id)],
    );
    const request = removing ? api.youtubeUnstar(id) : api.youtubeStar(payload);
    request
      .then((data) => {
        if (Array.isArray(data?.items)) setStarItems(data.items);
      })
      .catch((err) => {
        setStarItems(previous);
        setError(err?.message || "Could not update stars");
      });
  };

  const view =
    np && (trackTitle(np) || np.playing || np.paused || np.videoId || np.starting)
      ? np
      : null;
  const showNowPlaying = !!view;
  const title =
    trackTitle(view) || (view?.playing || view?.paused ? "Playing on projector" : "");
  const sub = [
    view?.artist,
    view?.starting ? "Starting" : view?.state || "",
  ]
    .filter((part) => part && String(part).toLowerCase() !== "null")
    .join(" · ");

  const metaLine = (item) =>
    [item?.channel, item?.length].filter(Boolean).join(" · ");

  const resBadge = (resolution, className = "res-badge") =>
    resolution ? (
      <span className={className} aria-label={`Resolution ${resolution}`}>
        {resolution}
      </span>
    ) : null;

  const asleep = projectorAsleep(state);

  return (
    <div className={`app ${typeVisible ? "keyboard-open" : ""} ${asleep ? "is-asleep" : ""}`}>
      <header className="topbar">
        <h1 className="brand">
          <img className="brand-mark" src="/projector.png" alt="" />
          <span>
            Horizon <em>Remote</em>
          </span>
        </h1>
        <div className="top-actions">
          <div className="accent-row" role="radiogroup" aria-label="Color">
            {ACCENTS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={accent === item.id}
                aria-label={item.label}
                title={item.label}
                className={`accent-dot accent-${item.id} ${accent === item.id ? "is-on" : ""}`}
                onClick={() => setAccent(item.id)}
              />
            ))}
        </div>
          <button
            type="button"
            className={`theme-switch ${theme}`}
            role="switch"
            aria-checked={theme === "dark"}
            aria-label={theme === "dark" ? "Switch to light" : "Switch to dark"}
            onClick={toggleTheme}
          >
            <span className="theme-switch-opt" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="4" fill="currentColor" />
                <path
                  d="M12 2.5v2.2M12 19.3v2.2M4.8 4.8l1.6 1.6M17.6 17.6l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.8 19.2l1.6-1.6M17.6 6.4l1.6-1.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                </svg>
            </span>
            <span className="theme-switch-opt" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path
                  d="M16.5 13.2A6.2 6.2 0 0 1 10.6 6 6.4 6.4 0 1 0 18 15.4a6.2 6.2 0 0 1-1.5-2.2Z"
                  fill="currentColor"
                />
                </svg>
            </span>
            <span className="theme-switch-thumb" />
          </button>
          <button
            type="button"
            className={`device-btn ${
              state?.powerMode === "off" || state?.powerOn === false
                ? "standby"
                : linked && state?.ok
                  ? "on"
                  : ""
            } ${deviceOpen ? "open" : ""}`}
            aria-expanded={deviceOpen}
            aria-label="Projector details"
            onClick={() => setDeviceOpen(true)}
          >
            <i />
            <span>
              {state?.powerMode === "off"
                ? "Off"
                : state?.powerOn === false || state?.powerMode === "standby"
                  ? "Standby"
                  : linked && state?.ok
                    ? "Device"
                    : "Connecting"}
            </span>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M6 3.5 10.5 8 6 12.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
                </svg>
          </button>
        </div>
      </header>

      <section className="search">
        <div className="search-row">
          <div
            className={`search-field${query ? " has-query" : ""}${
              searching && query.trim() ? " is-searching" : ""
            }`}
          >
            <SearchIcon />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search YouTube"
              value={query}
              onChange={(e) => {
                const next = e.target.value;
                setQuery(next);
                setOpenAc(true);
                if (next.trim()) {
                  // Show spinner as soon as typing diverges from settled results.
                  if (next.trim() !== resultsFor) setSearching(true);
                } else {
                  setSearching(false);
                }
              }}
              onFocus={() => {
                if (results.length) setOpenAc(true);
              }}
              onBlur={() => setTimeout(() => setOpenAc(false), 160)}
              autoComplete="off"
              spellCheck={false}
            />
            {searching && query.trim() ? (
              <span className="search-spinner" aria-label="Searching" />
            ) : null}
            {query ? (
              <button
                type="button"
                className="search-clear"
                aria-label="Clear search"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery("");
                  setSearching(false);
                  setOpenAc(false);
                  searchRef.current?.focus();
                }}
              >
                <CloseIcon size={22} />
              </button>
            ) : null}
          </div>
          {!showNowPlaying ? (
            <div className="kicker-actions">
              <button
                type="button"
                className="suggest-btn ghost history-chip"
                onClick={() => setStarsOpen(true)}
              >
                <StarIcon filled={starItems.length > 0} />
                <span>Starred</span>
              </button>
              <button
                type="button"
                className="suggest-btn ghost history-chip"
                onClick={() => setHistoryOpen(true)}
              >
                <HistoryIcon />
                <span>History</span>
              </button>
            </div>
          ) : null}
        </div>
        {openAc && results.length > 0 && sameSearchFamily(resultsFor, query) && (
          <div className="ac" role="listbox">
            {results.map((item, i) => (
              <MediaRow
                key={item.id}
                item={item}
                focused={i === sugIndex}
                starred={starredIds.has(item.id)}
                onPlay={playVideo}
                onToggleStar={toggleStar}
                onHover={() => setSugIndex(i)}
              />
            ))}
          </div>
        )}
      </section>

      {showNowPlaying ? (
      <section className="hero">
        <div className={`hero-art ${view?.starting ? "is-starting" : ""}`}>
          <YtStill videoId={view?.videoId} thumb={view?.thumb} preferSharp />
          <div className="shade" />
          {resBadge(view?.resolution, "res-badge hero-res")}
          {view?.starting ? (
            <div className="hero-loader" role="status" aria-label="Starting video">
              <i />
            </div>
          ) : null}
        </div>
        <div className="hero-body">
          <div>
            <div className="kicker-row">
              <div className="kicker">Now playing</div>
              <div className="kicker-actions">
                <button
                  type="button"
                  className={`suggest-btn ghost star-toggle ${
                    view?.videoId && starredIds.has(view.videoId) ? "is-on" : ""
                  }`}
                  disabled={!view?.videoId}
                  aria-pressed={!!(view?.videoId && starredIds.has(view.videoId))}
                  onClick={() =>
                    toggleStar({
                      id: view.videoId,
                      title,
                      channel: view?.artist || "",
                      resolution: view?.resolution || "",
                      thumb: ytFrame(view.videoId) || view?.thumb || "",
                      durationMs: view?.durationMs,
                      length: view?.length || "",
                    })
                  }
                >
                  <StarIcon filled={!!(view?.videoId && starredIds.has(view.videoId))} />
                  <span>Star</span>
                </button>
                <button
                  type="button"
                  className="suggest-btn ghost"
                  onClick={() => setStarsOpen(true)}
                >
                  <StarIcon filled={starItems.length > 0} />
                  <span>Starred</span>
                </button>
                <button
                  type="button"
                  className="suggest-btn ghost"
                  onClick={() => setHistoryOpen(true)}
                >
                  <HistoryIcon />
                  <span>History</span>
                </button>
                <button
                  type="button"
                  className="suggest-btn"
                  disabled={asleep || !view?.videoId}
                  onClick={() => setSuggestOpen(true)}
                >
                  <span>Suggested</span>
                  {suggestFor === view?.videoId && suggestItems.length ? (
                    <span className="suggest-count">{suggestItems.length}</span>
                  ) : null}
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M6 3.5 10.5 8 6 12.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                </svg>
                </button>
              </div>
            </div>
            <h2 className="hero-title">{title}</h2>
            {sub ? <div className="hero-sub">{sub}</div> : null}
          </div>
          <div className="hero-transport" inert={asleep}>
          <SeekBar
            positionMs={view?.positionMs}
            durationMs={view?.durationMs}
            playing={!view?.seeking && !!view?.playing && !view?.starting}
            progressAt={!view?.seeking && !view?.starting ? view?.progressAt : null}
            synced={!!view?.seeking || !!view?.progressSynced}
            seeking={!!view?.seeking}
            disabled={asleep || !view || !!view?.starting}
            onSeek={(sec) => requestSeek({ absoluteSec: sec })}
          />
          <div className="seek-row">
            {SEEK.filter((s) => s < 0).map((s) => (
              <button
                key={s}
                type="button"
                disabled={asleep || !!view?.starting}
                aria-label={`Back ${Math.abs(s)} seconds`}
                onClick={() => requestSeek({ deltaSec: s })}
              >
                <SeekIcon seconds={s} />
              </button>
            ))}
            <button
              type="button"
              className="play"
              disabled={asleep || !!view?.starting}
              aria-label={view?.starting ? "Starting" : view?.playing ? "Pause" : "Play"}
              onClick={() => media("play_pause")}
            >
              {view?.starting ? <LoaderIcon /> : view?.playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            {SEEK.filter((s) => s > 0).map((s) => (
              <button
                key={s}
                type="button"
                disabled={asleep || !!view?.starting}
                aria-label={`Forward ${s} seconds`}
                onClick={() => requestSeek({ deltaSec: s })}
              >
                <SeekIcon seconds={s} />
              </button>
            ))}
          </div>
          </div>
        </div>
      </section>
      ) : null}

      {deviceOpen ? (
        <DeviceSheet
          info={deviceInfo}
          loading={deviceLoading}
          error={deviceError}
          state={state}
          onClose={() => setDeviceOpen(false)}
          onRefresh={() => setDeviceGen((n) => n + 1)}
          resetting={resetting}
          onReset={() => {
            setResetting(true);
            setDeviceError("");
            api
              .resetState()
              .catch((e) => setDeviceError(e.message || "Could not reset"))
              .finally(() => setResetting(false));
          }}
        />
      ) : null}

      {suggestOpen ? (
        <div className="suggest-backdrop" onClick={() => setSuggestOpen(false)}>
          <aside
            className="suggest-panel"
            role="dialog"
            aria-label="Suggested videos"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="suggest-head">
              <h2>Suggested</h2>
              <button type="button" className="pill ghost" onClick={() => setSuggestOpen(false)}>
                Close
              </button>
            </div>
            {suggestLoading && !suggestItems.length ? (
              <div className="suggest-status">
                <span className="search-spinner" aria-hidden />
                Finding videos
              </div>
            ) : null}
            {!suggestLoading && !np?.videoId ? (
              <div className="suggest-status">Play a YouTube video to see suggestions.</div>
            ) : null}
            {!suggestLoading && np?.videoId && !suggestItems.length ? (
              <div className="suggest-status">No suggestions for this video.</div>
            ) : null}
            <div className="suggest-list" ref={suggestListRef}>
              {suggestItems.map((item) => (
                <MediaRow
                  key={item.id}
                  item={item}
                  starred={starredIds.has(item.id)}
                  onPlay={playVideo}
                  onToggleStar={toggleStar}
                />
              ))}
              {suggestToken ? (
                <div className="suggest-more" ref={suggestSentinelRef}>
                  {suggestMore ? (
                    <>
                      <span className="search-spinner" aria-hidden />
                      Loading more
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}

      {historyOpen ? (
        <div className="suggest-backdrop" onClick={() => setHistoryOpen(false)}>
          <aside
            className="suggest-panel"
            role="dialog"
            aria-label="YouTube history"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="suggest-head">
              <h2>History</h2>
              <button type="button" className="pill ghost" onClick={() => setHistoryOpen(false)}>
                Close
              </button>
            </div>
            {historyLoading && !historyItems.length ? (
              <div className="suggest-status">
                <span className="search-spinner" aria-hidden />
                Loading history
              </div>
            ) : null}
            {historyError ? <div className="suggest-status">{historyError}</div> : null}
            {!historyLoading && !historyError && !historyItems.length ? (
              <div className="suggest-status">
                History appears when YouTube plays on the projector — from this
                remote or the TV itself.
              </div>
            ) : null}
            <div className="suggest-list">
              {historyItems.map((item) => (
                <MediaRow
                  key={`${item.id}-${item.playedAt}`}
                  item={item}
                  starred={starredIds.has(item.id)}
                  onPlay={playVideo}
                  onToggleStar={toggleStar}
                />
              ))}
            </div>
          </aside>
        </div>
      ) : null}

      {starsOpen ? (
        <div className="suggest-backdrop" onClick={() => setStarsOpen(false)}>
          <aside
            className="suggest-panel"
            role="dialog"
            aria-label="Starred videos"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="suggest-head">
              <h2>Starred</h2>
              <button type="button" className="pill ghost" onClick={() => setStarsOpen(false)}>
                Close
              </button>
            </div>
            {starsLoading && !starItems.length ? (
              <div className="suggest-status">
                <span className="search-spinner" aria-hidden />
                Loading starred videos
              </div>
            ) : null}
            {starsError ? <div className="suggest-status">{starsError}</div> : null}
            {!starsLoading && !starsError && !starItems.length ? (
              <div className="suggest-status">
                Star a video from search, suggestions, history, or what’s playing.
                Stars stay on the server for every remote.
              </div>
            ) : null}
            <div className="suggest-list">
              {starItems.map((item) => (
                <MediaRow
                  key={item.id}
                  item={item}
                  starred
                  onPlay={playVideo}
                  onToggleStar={toggleStar}
                />
              ))}
            </div>
          </aside>
        </div>
      ) : null}

      <div className="grid-2">
        <section className="panel">
          <h2>Controls</h2>
          <div className="source-row" role="radiogroup" aria-label="Source" inert={asleep}>
            {sources.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={!!item.active}
                className={`${item.active ? "on" : ""} ${
                  item.id !== "apps" && item.connected === false ? "is-disconnected" : ""
                }`}
                disabled={!!sourceBusy}
                onClick={() => selectSource(item.id)}
              >
                {item.id === "apps" ? <AppsIcon /> : <HdmiIcon />}
                <span className="source-copy">
                  <span className="source-name">{item.label}</span>
                  {item.id !== "apps" ? (
                    <span className="source-cable">
                      {item.connected === true
                        ? "Connected"
                        : item.connected === false
                          ? "No cable"
                          : ""}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>

          <div className="sliders" inert={asleep}>
            <div className="volume-row">
              <button
                type="button"
                className="vol-step"
                aria-label="Volume down"
                onClick={() =>
                  commitVolume(Math.max(0, (volumeHoldRef.current ?? state?.volume ?? 0) - 1))
                }
              >
                −
              </button>
              <ValueSlider
                label={
                  <VolumeIcon
                    level={state?.volume ?? 0}
                    max={state?.volumeMax ?? 25}
                    muted={!!state?.muted}
                  />
                }
                ariaLabel="Volume"
                min={0}
                max={state?.volumeMax ?? 25}
                value={state?.volume ?? 0}
                onChange={previewVolume}
                onCommit={commitVolume}
              />
              <button
                type="button"
                className="vol-step"
                aria-label="Volume up"
                onClick={() => {
                  const max = state?.volumeMax || 100;
                  commitVolume(
                    Math.min(max, (volumeHoldRef.current ?? state?.volume ?? 0) + 1),
                  );
                }}
              >
                +
              </button>
            </div>
            <ValueSlider
              label={<SunIcon />}
              ariaLabel="Brightness"
              min={1}
              max={11}
              splitAfter={10}
              value={brightnessValue}
              displayValue={(v) => (v >= 11 ? "Boost" : String(v))}
              onChange={(level) => {
                brightnessHoldRef.current = level;
                patchState({
                  brightnessScale: level,
                  luminanceBoost: level >= 11,
                  brightness: Math.min(10, level),
                });
              }}
              onCommit={(level) => {
                brightnessHoldRef.current = level;
                patchState({
                  brightnessScale: level,
                  luminanceBoost: level >= 11,
                  brightness: Math.min(10, level),
                });
                api.brightness(level);
              }}
            />
          </div>

          <div className="switches">
            <div className={`power-switch ${state?.powerOn ? "on" : ""} ${asleep ? "wake" : ""}`} ref={powerSwitchRef}>
              <button
                type="button"
                className={`switch ${state?.powerOn ? "on" : ""}`}
                aria-label={state?.powerOn ? "Standby" : "Wake"}
                onClick={() => {
                  setPowerMenu(false);
                  startPowerRef.current(state?.powerOn ? false : true);
                }}
              >
                <PowerIcon />
                <span className="name">Power</span>
                <span className="track" />
              </button>
              <button
                type="button"
                className="power-more"
                aria-label="Shut down or reboot"
                aria-expanded={powerMenu}
                disabled={asleep}
                onClick={(e) => {
                  e.stopPropagation();
                  setPowerMenu((open) => !open);
                }}
              >
                <ChevronIcon dir="down" size={16} />
              </button>
              {powerMenu ? (
                <div
                  className="power-menu"
                  role="menu"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPowerMenu(false);
                      setPowerAsk("shutdown");
                    }}
                  >
                    Shut down
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPowerMenu(false);
                      setPowerAsk("reboot");
                    }}
                  >
                    Reboot
                  </button>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className={`switch ${state?.screenOn ? "on" : ""}`}
              aria-label={state?.screenOn ? "Screen off" : "Screen on"}
              disabled={asleep}
              onClick={() => {
                const on = !(screenHoldRef.current ?? state?.screenOn);
                screenHoldRef.current = on;
                patchState({ screenOn: on });
                api.screen(on);
              }}
            >
              <ScreenIcon />
              <span className="name">Screen</span>
              <span className="track" />
            </button>
            <button
              type="button"
              className={`switch ${state?.muted ? "on" : ""}`}
              aria-label={state?.muted ? "Unmute" : "Mute"}
              disabled={asleep}
              onClick={() => {
                const on = !(mutedHoldRef.current ?? state?.muted);
                if (on) {
                  const level = volumeHoldRef.current ?? state?.volume ?? 0;
                  if (level > 0) volumeBeforeMuteRef.current = level;
                  volumeHoldRef.current = 0;
                  mutedHoldRef.current = true;
                  patchState({ muted: true, volume: 0 });
                } else {
                  const restore = volumeBeforeMuteRef.current ?? state?.volume ?? 0;
                  volumeHoldRef.current = restore;
                  mutedHoldRef.current = false;
                  patchState({ muted: false, volume: restore });
                }
                api.mute(on);
              }}
            >
              <MuteIcon muted={!!state?.muted} />
              <span className="name">{state?.muted ? "Unmute" : "Mute"}</span>
              <span className="track" />
            </button>
          </div>
        </section>

        <section className="panel" inert={asleep}>
          <h2>Remote</h2>
          <div className="pad-wrap">
            <SwipePad
              onDirection={(dir) => sendKey(dir)}
              onOk={() => sendKey("ok")}
            />
            <div className="dpad dpad-desktop">
              <button type="button" className="up" aria-label="Up" onClick={() => sendKey("up")}>
                <ChevronIcon dir="up" />
              </button>
              <button type="button" className="left" aria-label="Left" onClick={() => sendKey("left")}>
                <ChevronIcon dir="left" />
              </button>
              <button type="button" className="ok" aria-label="OK" onClick={() => sendKey("ok")}>
                OK
              </button>
              <button type="button" className="right" aria-label="Right" onClick={() => sendKey("right")}>
                <ChevronIcon dir="right" />
              </button>
              <button type="button" className="down" aria-label="Down" onClick={() => sendKey("down")}>
                <ChevronIcon dir="down" />
              </button>
            </div>
            <div className="nav">
              <button type="button" aria-label="Home" onClick={() => sendKey("home")}>
                <HomeIcon />
              </button>
              <button type="button" aria-label="Back" onClick={() => sendKey("back")}>
                <BackIcon />
              </button>
              <button
                type="button"
                className="type-tv"
                aria-label="Type on TV"
                onClick={openTypeOnTv}
              >
                <KeyboardIcon />
                <span>Type</span>
              </button>
            </div>
          </div>
        </section>
      </div>

      <section className="panel" inert={asleep}>
        <h2>Apps</h2>
        <div className="apps">
          {apps.map((app, i) => (
            <button
              key={app.package}
              type="button"
              className="app-tile"
              onClick={() => launchApp(app)}
            >
              <AppIcon app={app} />
              <div className="name">{app.label}</div>
            </button>
          ))}
        </div>
      </section>

      <div className={`status ${error ? "err" : ""}`}>
        {error || status}
      </div>
      <div className="legend">
        <kbd>⌘</kbd><kbd>K</kbd> search · <kbd>Esc</kbd> back · <kbd>⌫</kbd> back ·{" "}
        <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> move · <kbd>Enter</kbd> OK ·{" "}
        <kbd>Space</kbd> play/pause · <kbd>⌘</kbd><kbd>↑</kbd><kbd>↓</kbd> volume ·{" "}
        <kbd>⇧</kbd><kbd>↑</kbd><kbd>↓</kbd> brightness · <kbd>M</kbd> mute
      </div>
      {typeVisible && !asleep ? (
        <form
          ref={typeBarRef}
          className="tv-type"
          onSubmit={(e) => {
            e.preventDefault();
            typeEnterRef.current = true;
            clearTimeout(typeTimerRef.current);
            flushType();
          }}
        >
          <input
            ref={typeRef}
            value={typeDraft}
            autoFocus
            inputMode="text"
            enterKeyHint="send"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Type here — it goes to the TV"
            aria-label="Type on the TV"
            onChange={(e) => {
              const next = e.target.value;
              setTypeDraft(next);
              queueType(next);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setTypeForced(false);
                setTypeHiddenGen(kbGenRef.current);
                return;
              }
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                typeEnterRef.current = true;
                clearTimeout(typeTimerRef.current);
                flushType();
              } else if (e.key === "Backspace" && e.currentTarget.value === "") {
                e.preventDefault();
                typeExtraDeletesRef.current += 1;
                clearTimeout(typeTimerRef.current);
                flushType();
              }
            }}
          />
        </form>
      ) : null}
      {powerAsk ? (
        <div className="suggest-backdrop confirm-backdrop" onClick={() => setPowerAsk("")}>
          <div
            className="confirm-card"
            role="dialog"
            aria-label={powerAsk === "shutdown" ? "Shut down" : "Reboot"}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>{powerAsk === "shutdown" ? "Shut down?" : "Reboot?"}</h2>
            <p>
              {powerAsk === "shutdown"
                ? "This powers the projector off completely. The power switch only puts it in standby. You will need the button on the projector to turn it back on."
                : "The projector will turn off and start again. It will be unreachable for a minute."}
            </p>
            <div className="confirm-actions">
              <button type="button" className="pill ghost" onClick={() => setPowerAsk("")}>
                Cancel
              </button>
              <button
                type="button"
                className="pill danger"
                onClick={() => {
                  const kind = powerAsk;
                  setPowerAsk("");
                  setPowerProgress({
                    active: true,
                    kind,
                    title: kind === "shutdown" ? "Shutting down" : "Rebooting projector",
                    steps: [],
                    done: 0,
                    total: kind === "shutdown" ? 2 : 8,
                  });
                  const run = kind === "shutdown" ? api.powerShutdown() : api.powerReboot();
                  run.catch((err) => setError(err.message || "Power command failed"));
                }}
              >
                {powerAsk === "shutdown" ? "Shut down" : "Reboot"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {powerProgress ? (
        <div className="wake-screen" role="dialog" aria-label={powerProgress.title || "Projector"}>
          <div className="wake-card">
            <h2>{powerProgress.title || "Projector"}</h2>
            <div className="wake-bar" aria-hidden="true">
              {Array.from(
                { length: Math.max(1, powerProgress.total || powerProgress.steps?.length || 1) },
                (_, i) => (
                  <i
                    key={i}
                    className={
                      i < (powerProgress.done || 0)
                        ? "done"
                        : powerProgress.active && i === (powerProgress.done || 0)
                          ? "active"
                          : ""
                    }
                  />
                ),
              )}
            </div>
            <ol className="wake-steps">
              {(powerProgress.steps || []).map((step) => (
                <li key={step.id} className={step.status || "pending"}>
                  <b>{step.label}</b>
                  {step.status === "active" && step.detail ? <span>{step.detail}</span> : null}
                </li>
              ))}
            </ol>
            {!powerProgress.steps?.length ? (
              <p className="wake-wait">Checking the projector</p>
            ) : null}
            {powerProgress.error ? <p className="wake-error">{powerProgress.error}</p> : null}
            {powerProgress.error ? (
              <button type="button" className="pill" onClick={() => setPowerProgress(null)}>
                Close
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
