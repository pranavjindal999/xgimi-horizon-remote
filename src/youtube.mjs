/**
 * YouTube search via InnerTube JSON (fast) with HTML fallback.
 * No API key.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const YOUTUBE_TV =
  "com.google.android.youtube.tv/com.google.android.apps.youtube.tv.activity.ShellActivity";
const FALLBACK_VIDEO_ID = /"videoId":"([a-zA-Z0-9_-]{11})"/;

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 80;
const searchCache = new Map(); // q -> { at, results }

/** Prefer exact labels from playback / history over thumbnail "HD". */
const RES_RANK = {
  "4K": 6,
  "1440p": 5,
  "1080p": 4,
  "720p": 3,
  HD: 2,
  "480p": 1,
};

let resStorePath = null;
const resMemory = new Map(); // videoId -> label
const thumbMiss = new Set();
let resDirty = false;
let resWriteTimer = null;

const MWEB_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const WEB_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function configureResolutionStore(storagePath) {
  resStorePath = path.join(storagePath || ".", "youtube-resolutions.json");
  try {
    const raw = fs.readFileSync(resStorePath, "utf8");
    const data = JSON.parse(raw);
    const map = data?.resolutions && typeof data.resolutions === "object"
      ? data.resolutions
      : data;
    if (map && typeof map === "object") {
      for (const [id, label] of Object.entries(map)) {
        if (id && label) resMemory.set(String(id), String(label));
      }
    }
  } catch {
    // first write creates the file
  }
}

export function lookupResolution(videoId) {
  return resMemory.get(String(videoId || "").trim()) || null;
}

export function rememberResolution(videoId, label) {
  const id = String(videoId || "").trim();
  const res = String(label || "").trim();
  if (!id || !res) return;
  const prev = resMemory.get(id);
  if (prev === res) return;
  if (prev && (RES_RANK[prev] || 0) > (RES_RANK[res] || 0)) return;
  resMemory.set(id, res);
  thumbMiss.delete(id);
  if (!resStorePath) return;
  resDirty = true;
  if (resWriteTimer) return;
  resWriteTimer = setTimeout(() => {
    resWriteTimer = null;
    if (!resDirty || !resStorePath) return;
    resDirty = false;
    const resolutions = Object.fromEntries(resMemory);
    const tmp = `${resStorePath}.${process.pid}.tmp`;
    void fsp
      .mkdir(path.dirname(resStorePath), { recursive: true })
      .then(() =>
        fsp.writeFile(tmp, `${JSON.stringify({ resolutions }, null, 2)}\n`),
      )
      .then(() => fsp.rename(tmp, resStorePath))
      .catch(() => {});
  }, 250);
}

function betterResolution(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return (RES_RANK[b] || 0) > (RES_RANK[a] || 0) ? b : a;
}

/** maxres/hq720 thumbs exist for most HD uploads — player formats are blocked on LAN hosts. */
async function resolutionFromThumb(videoId) {
  const id = String(videoId || "").trim();
  if (!id || thumbMiss.has(id)) return null;
  let notFound = 0;
  for (const name of ["maxresdefault.jpg", "hq720.jpg"]) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`https://i.ytimg.com/vi/${id}/${name}`, {
          method: "HEAD",
          signal: AbortSignal.timeout(5_000),
        });
        const len = Number(response.headers.get("content-length") || 0);
        if (response.ok && len > 5000) return "HD";
        if (response.status === 404) {
          notFound += 1;
          break;
        }
      } catch {
        // transient — retry once, never poison the miss cache
        if (attempt === 0) await new Promise((r) => setTimeout(r, 120));
      }
    }
  }
  if (notFound >= 2) thumbMiss.add(id);
  return null;
}

function cacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  // LRU touch
  searchCache.delete(key);
  searchCache.set(key, hit);
  const results = hit.results;
  if (Array.isArray(results)) {
    for (const item of results) {
      if (!item?.id) continue;
      const known = lookupResolution(item.id);
      if (known) item.resolution = betterResolution(item.resolution, known);
    }
  }
  return results;
}

function cacheSet(key, results) {
  searchCache.set(key, { at: Date.now(), results });
  while (searchCache.size > CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    searchCache.delete(oldest);
  }
}

function runsText(node) {
  if (!node) return "";
  if (typeof node.simpleText === "string") return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text).join("");
  return "";
}

function lengthSeconds(text) {
  if (!text) return null;
  const parts = String(text)
    .trim()
    .split(":")
    .map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function formatResolutionLabel(height, qualityLabel = "") {
  const fromLabel = String(qualityLabel || "");
  if (/4k|uhd/i.test(fromLabel)) return "4K";
  const m = /(\d{3,4})p/i.exec(fromLabel);
  if (m) {
    const h = Number(m[1]);
    if (h >= 2160) return "4K";
    if (h > 0) return `${h}p`;
  }
  const h = Number(height) || 0;
  if (h >= 2160) return "4K";
  if (h >= 1440) return "1440p";
  if (h >= 1080) return "1080p";
  if (h >= 720) return "720p";
  if (h >= 480) return "480p";
  if (h > 0) return `${h}p`;
  return null;
}

/** Infer from title / badges when YouTube blocks format lookups (common on LAN servers). */
export function resolutionFromText(...parts) {
  const text = parts.filter(Boolean).join(" ");
  if (!text) return null;
  if (/4\s*k|2160\s*p|\buhd\b/i.test(text)) return "4K";
  if (/1440\s*p|\bqhd\b/i.test(text)) return "1440p";
  if (/1080\s*p|full\s*hd/i.test(text)) return "1080p";
  if (/720\s*p/i.test(text)) return "720p";
  if (/480\s*p/i.test(text)) return "480p";
  if (/\bhd\b/i.test(text)) return "HD";
  return null;
}

/** Label for an on-device SurfaceFlinger buffer size. */
export function resolutionFromSize(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return null;
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (long >= 3800 || short >= 2100) return "4K";
  if (long >= 2500 || short >= 1400) return "1440p";
  if (long >= 1900 || short >= 1000) return "1080p";
  if (long >= 1200 || short >= 700) return "720p";
  if (long >= 800 || short >= 480) return "480p";
  return `${short}p`;
}

function normalizeResolutionBadge(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (/^(4k|uhd)$/i.test(t)) return "4K";
  if (/^hd$/i.test(t)) return "HD";
  if (/^\d{3,4}p$/i.test(t)) {
    const h = Number.parseInt(t, 10);
    if (h >= 2160) return "4K";
    return `${h}p`;
  }
  const m = /(\d{3,4})\s*p/i.exec(t);
  if (m) {
    const h = Number(m[1]);
    return h >= 2160 ? "4K" : `${h}p`;
  }
  if (/4k|uhd/i.test(t)) return "4K";
  return null;
}

function resolutionFromBadges(list) {
  if (!Array.isArray(list)) return null;
  for (const badge of list) {
    const label =
      badge?.metadataBadgeRenderer?.label ||
      badge?.metadataBadgeRenderer?.labelRows?.[0] ||
      badge?.thumbnailBadgeViewModel?.text ||
      "";
    const hit = normalizeResolutionBadge(label);
    if (hit) return hit;
  }
  return null;
}

function resolutionFromRenderer(v) {
  if (!v) return null;
  const fromBadges = resolutionFromBadges(v.badges);
  if (fromBadges) return fromBadges;
  for (const overlay of v.thumbnailOverlays || []) {
    const hit = resolutionFromBadges(
      overlay?.thumbnailBottomOverlayViewModel?.badges,
    );
    if (hit) return hit;
  }
  return null;
}

function fromVideoRenderer(v) {
  if (!v?.videoId) return null;
  return {
    id: v.videoId,
    title: runsText(v.title) || runsText(v.headline) || "",
    length: runsText(v.lengthText) || "",
    channel:
      runsText(v.ownerText) ||
      runsText(v.shortBylineText) ||
      runsText(v.longBylineText) ||
      "",
    resolution: resolutionFromRenderer(v),
  };
}

function fromVideoWithContext(v) {
  if (!v) return null;
  const id = v.videoId || v.navigationEndpoint?.watchEndpoint?.videoId;
  if (!id) return null;
  return {
    id,
    title: runsText(v.headline) || runsText(v.title) || "",
    length: runsText(v.lengthText) || "",
    channel: runsText(v.shortBylineText) || runsText(v.longBylineText) || "",
    resolution: resolutionFromRenderer(v),
  };
}

/** Shallow extract from InnerTube search JSON — avoids walking the whole tree. */
function collectFromInnertube(data) {
  const out = [];
  const sections =
    data?.contents?.sectionListRenderer?.contents ||
    data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
      ?.sectionListRenderer?.contents ||
    [];

  for (const section of sections) {
    const items = section.itemSectionRenderer?.contents || [];
    for (const item of items) {
      const row =
        fromVideoWithContext(item.videoWithContextRenderer) ||
        fromVideoRenderer(item.videoRenderer) ||
        fromVideoRenderer(item.compactVideoRenderer);
      if (row) out.push(row);
    }
  }

  if (out.length) return out;

  // Fallback deep walk if layout changes
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node.videoWithContextRenderer) {
      const row = fromVideoWithContext(node.videoWithContextRenderer);
      if (row) out.push(row);
      return;
    }
    if (node.videoRenderer?.videoId) {
      const row = fromVideoRenderer(node.videoRenderer);
      if (row) out.push(row);
      return;
    }
    if (node.reelItemRenderer || node.shortsLockupViewModel) return;
    for (const value of Object.values(node)) walk(value);
  };
  walk(data);
  return out;
}

function rankVideos(videos) {
  const seen = new Set();
  const unique = [];
  for (const v of videos) {
    if (!v?.id || seen.has(v.id)) continue;
    seen.add(v.id);
    unique.push(v);
  }
  const longEnough = unique.filter((v) => {
    const sec = lengthSeconds(v.length);
    return sec == null || sec >= 60;
  });
  const shorts = unique.filter((v) => {
    const sec = lengthSeconds(v.length);
    return sec != null && sec < 60;
  });
  return [...longEnough, ...shorts];
}

function mapResults(ranked, limit) {
  return ranked.slice(0, limit).map((v) => ({
    id: v.id,
    title: v.title || v.id,
    length: v.length || "",
    channel: v.channel || "",
    resolution:
      v.resolution ||
      resolutionFromText(v.title, v.channel, v.length) ||
      null,
    thumb: youtubeThumbUrl(v.id),
  }));
}

export function youtubeThumbUrl(videoId) {
  if (!videoId) return null;
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

export function youtubeWatchUrl(videoId, startSeconds = 0) {
  const base = `https://www.youtube.com/watch?v=${videoId}`;
  if (startSeconds > 0) return `${base}&t=${Math.floor(startSeconds)}s`;
  return base;
}

export function youtubeLaunchCommand(videoId, startSeconds = 0) {
  const watch = youtubeWatchUrl(videoId, startSeconds);
  return `am start -a android.intent.action.VIEW -d '${watch}' -n ${YOUTUBE_TV}`;
}

function searchSignal(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

async function searchInnertube(query, signal) {
  const response = await fetch(
    "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": MWEB_UA,
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: JSON.stringify({
        context: {
          client: {
            hl: "en",
            gl: "US",
            clientName: "MWEB",
            clientVersion: "2.20241125.01.00",
          },
        },
        query,
      }),
      signal: searchSignal(signal, 8_000),
    },
  );
  if (!response.ok) {
    throw new Error(`YouTube InnerTube HTTP ${response.status}`);
  }
  const data = await response.json();
  return rankVideos(collectFromInnertube(data));
}

function extractYtInitialData(html) {
  const marker = "var ytInitialData = ";
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const jsonStart = start + marker.length;
  if (html[jsonStart] !== "{") return null;
  let depth = 0;
  for (let i = jsonStart; i < html.length; i++) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(jsonStart, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function collectSearchVideos(data) {
  return collectFromInnertube(data);
}

async function searchHtml(query, signal) {
  const url =
    "https://www.youtube.com/results?search_query=" + encodeURIComponent(query);
  const response = await fetch(url, {
    headers: {
      "User-Agent": WEB_UA,
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: searchSignal(signal, 12_000),
  });
  if (!response.ok) {
    throw new Error(`YouTube search HTTP ${response.status}`);
  }
  const html = await response.text();
  const data = extractYtInitialData(html);
  let ranked = data ? rankVideos(collectSearchVideos(data)) : [];
  if (!ranked.length) {
    const match = FALLBACK_VIDEO_ID.exec(html);
    if (match) ranked = [{ id: match[1], title: query, length: "", channel: "" }];
  }
  return ranked;
}

/**
 * @returns {Promise<Array<{id,title,length,channel,thumb}>>}
 */
function applyKnownResolutions(items) {
  const list = Array.isArray(items) ? items : [];
  for (const item of list) {
    if (!item?.id) continue;
    const fromText = resolutionFromText(item.title, item.channel, item.length);
    const fromCache = lookupResolution(item.id);
    const best = betterResolution(
      betterResolution(item.resolution, fromText),
      fromCache,
    );
    if (best) {
      item.resolution = best;
      rememberResolution(item.id, best);
    }
  }
}

export async function searchYoutubeSuggestions(query, limit = 8, { signal } = {}) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  if (signal?.aborted) return [];

  const cacheKey = `${q.toLowerCase()}|${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  let ranked = [];
  try {
    ranked = await searchInnertube(q, signal);
  } catch (err) {
    if (signal?.aborted) return [];
    // HTML scrape is slow (~3–5s) — only as last resort when InnerTube errors.
    try {
      ranked = await searchHtml(q, signal);
    } catch {
      ranked = [];
    }
  }
  if (signal?.aborted) return [];

  const results = mapResults(ranked, limit);
  // Title and previously learned labels only. Thumbnail probes used to block
  // the response for 1–2s after YouTube had already answered.
  applyKnownResolutions(results);
  if (results.length) cacheSet(cacheKey, results);
  if (results.some((item) => item?.id && !item.resolution)) {
    void attachResolutions(results, { concurrency: 6, limit }).catch(() => {});
  }
  return results;
}

/** Warm DNS/TLS to YouTube so the first user search is not cold. */
export function warmYoutubeSearch() {
  searchYoutubeSuggestions("a", 1).catch(() => {});
}

function lockupDuration(vm) {
  const overlays = vm?.contentImage?.thumbnailViewModel?.overlays || [];
  for (const overlay of overlays) {
    const badges = overlay?.thumbnailBottomOverlayViewModel?.badges || [];
    for (const badge of badges) {
      const text = badge?.thumbnailBadgeViewModel?.text || "";
      if (/^\d+:\d{2}/.test(text)) return text;
    }
  }
  return "";
}

function lockupResolution(vm) {
  const overlays = vm?.contentImage?.thumbnailViewModel?.overlays || [];
  for (const overlay of overlays) {
    const badges = overlay?.thumbnailBottomOverlayViewModel?.badges || [];
    const hit = resolutionFromBadges(badges);
    if (hit) return hit;
  }
  return (
    resolutionFromBadges(vm?.metadata?.lockupMetadataViewModel?.badges) || null
  );
}

function lockupChannel(vm) {
  const rows =
    vm?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel
      ?.metadataRows || [];
  const part = rows[0]?.metadataParts?.[0]?.text?.content;
  return typeof part === "string" ? part : "";
}

const NEXT_CONTEXT = {
  client: {
    hl: "en",
    gl: "US",
    clientName: "WEB",
    clientVersion: "2.20241126.01.00",
  },
};

function continuationToken(data) {
  const fromList = (list) => {
    if (!Array.isArray(list)) return null;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const token =
        list[i]?.continuationItemRenderer?.continuationEndpoint
          ?.continuationCommand?.token;
      if (token) return token;
    }
    return null;
  };
  const direct = fromList(
    data?.contents?.twoColumnWatchNextResults?.secondaryResults
      ?.secondaryResults?.results,
  );
  if (direct) return direct;
  for (const endpoint of data?.onResponseReceivedEndpoints || []) {
    const token = fromList(
      endpoint?.appendContinuationItemsAction?.continuationItems,
    );
    if (token) return token;
  }
  return null;
}

function collectLockups(data, currentId) {
  const rows = [];
  const walk = (node) => {
    if (!node || typeof node !== "object" || rows.length >= 40) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node.lockupViewModel) {
      const vm = node.lockupViewModel;
      const contentId = String(vm.contentId || "");
      const kind = String(vm.contentType || "");
      if (
        /^[a-zA-Z0-9_-]{11}$/.test(contentId) &&
        contentId !== currentId &&
        !/SHORT/i.test(kind)
      ) {
        rows.push({
          id: contentId,
          title:
            vm.metadata?.lockupMetadataViewModel?.title?.content || contentId,
          length: lockupDuration(vm),
          channel: lockupChannel(vm),
          resolution: lockupResolution(vm),
        });
      }
      return;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(data);
  return rows;
}

/**
 * One page of videos YouTube shows next to the one that is playing.
 * Pass `continuation` to load the following page.
 * @returns {Promise<{results: Array<{id,title,length,channel,thumb}>, continuation: string|null}>}
 */
export async function relatedYoutubeVideos(videoId, continuation = "") {
  const id = String(videoId || "").trim();
  const token = String(continuation || "").trim();
  if (token) {
    if (token.length > 8000) return { results: [], continuation: null };
  } else if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    return { results: [], continuation: null };
  }

  const cacheKey = token ? `related|c|${token}` : `related|${id}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    if (Array.isArray(cached.results)) {
      void attachResolutions(cached.results, { concurrency: 4, limit: 16 }).then(() => {
        cacheSet(cacheKey, cached);
      });
    }
    return cached;
  }

  const response = await fetch(
    "https://www.youtube.com/youtubei/v1/next?prettyPrint=false",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": WEB_UA,
        "Accept-Language": "en-US,en;q=0.9",
      },
      body: JSON.stringify(
        token
          ? { context: NEXT_CONTEXT, continuation: token }
          : { context: NEXT_CONTEXT, videoId: id },
      ),
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!response.ok) throw new Error(`YouTube next HTTP ${response.status}`);
  const data = await response.json();
  const page = {
    results: mapResults(rankVideos(collectLockups(data, id)), 40),
    continuation: continuationToken(data),
  };
  applyKnownResolutions(page.results);
  if (page.results.length) cacheSet(cacheKey, page);
  // Badges fill in after the list is already on screen.
  void attachResolutions(page.results, { concurrency: 4, limit: 16 }).then(() => {
    if (page.results.length) cacheSet(cacheKey, page);
  });
  return page;
}

export function normalizeTitle(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when two titles likely refer to the same video. */
export function titlesCompatible(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const n = Math.min(28, na.length, nb.length);
  return n >= 18 && na.slice(0, n) === nb.slice(0, n);
}

function namesMatch(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Pick the result that is actually this track. Title-only matching returns
 * a different video that happens to share a short name.
 */
export function pickYoutubeMatch(results, hint = {}) {
  const title = hint.title || "";
  const artist = String(hint.artist || "").trim();
  const durationMs = Number(hint.durationMs);
  const hasDuration = Number.isFinite(durationMs) && durationMs > 0;
  let best = null;
  let bestScore = -Infinity;
  for (const result of results || []) {
    if (!result?.id) continue;
    let score = 0;
    if (normalizeTitle(result.title) === normalizeTitle(title)) score += 40;
    else if (titlesCompatible(result.title, title)) score += 25;
    else score -= 40;
    if (artist) {
      score += namesMatch(result.channel, artist) ? 50 : -20;
    }
    const lengthMs = parseLengthToMs(result.length);
    if (hasDuration && lengthMs) {
      const delta = Math.abs(lengthMs - durationMs);
      if (delta <= 2000) score += 40;
      else if (delta <= 8000) score += 15;
      else if (delta > 20000) score -= 50;
    }
    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  }
  if (!best || bestScore < 25) return null;
  return best;
}

export async function searchYoutubeVideo(query, hint = null) {
  const results = await searchYoutubeSuggestions(query, 8, {});
  if (!results.length) throw new Error(`No YouTube video found for: ${query}`);
  const best = hint
    ? pickYoutubeMatch(results, { title: hint.title || query, ...hint })
    : results.find((r) => titlesCompatible(r.title, query)) || results[0];
  if (!best) throw new Error(`No YouTube video found for: ${query}`);
  return {
    videoId: best.id,
    title: best.title,
    length: best.length || "",
    durationMs: parseLengthToMs(best.length),
  };
}

const metaCache = new Map(); // videoId -> { ms, title, resolution }

function resolutionFromPlayer(data) {
  const formats = [
    ...(data?.streamingData?.adaptiveFormats || []),
    ...(data?.streamingData?.formats || []),
  ];
  let bestH = 0;
  let bestLabel = "";
  for (const f of formats) {
    const h = Number(f?.height) || 0;
    if (h > bestH) {
      bestH = h;
      bestLabel = f?.qualityLabel || "";
    } else if (h === bestH && f?.qualityLabel && !bestLabel) {
      bestLabel = f.qualityLabel;
    }
  }
  return formatResolutionLabel(bestH, bestLabel);
}

function bestResolutionFromLabels(labels) {
  let bestH = 0;
  let best = null;
  for (const label of labels || []) {
    if (/4k|uhd/i.test(label)) {
      return "4K";
    }
    const m = /(\d{3,4})p/i.exec(label);
    const h = m ? Number(m[1]) : 0;
    if (h > bestH) {
      bestH = h;
      best = formatResolutionLabel(h, label);
    }
  }
  return best;
}

/** Watch-page scrape — player streamingData is often empty without a poToken. */
async function resolutionFromWatchHtml(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      "User-Agent": WEB_UA,
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return null;
  const html = await response.text();
  const labels = [...html.matchAll(/"qualityLabel":"([^"]+)"/g)].map((m) => m[1]);
  return bestResolutionFromLabels(labels);
}

/**
 * Duration + max resolution via InnerTube player (cached).
 * If expectedTitle is set, reject mismatches so we don't show another cut's length.
 * @returns {Promise<{ms:number, title:string, resolution:string|null}|null>}
 */
export async function youtubeVideoMeta(videoId, expectedTitle = null) {
  const id = String(videoId || "").trim();
  if (!id) return null;
  const cached = metaCache.get(id);
  if (cached) {
    if (expectedTitle && !titlesCompatible(cached.title, expectedTitle)) {
      return null;
    }
    return cached;
  }
  try {
    const response = await fetch(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": MWEB_UA,
        },
        body: JSON.stringify({
          context: {
            client: {
              hl: "en",
              gl: "US",
              clientName: "MWEB",
              clientVersion: "2.20241125.01.00",
            },
          },
          videoId: id,
        }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) return null;
    const data = await response.json();
    const sec = Number(data?.videoDetails?.lengthSeconds);
    const title = data?.videoDetails?.title || "";
    if (!Number.isFinite(sec) || sec <= 0) return null;
    let resolution = resolutionFromPlayer(data);
    // Watch-page scrape is usually 429 from LAN servers — skip it.
    if (!resolution) {
      resolution = resolutionFromText(title, expectedTitle);
    }
    if (resolution) rememberResolution(id, resolution);
    const entry = {
      ms: Math.round(sec * 1000),
      title,
      resolution,
    };
    metaCache.set(id, entry);
    if (expectedTitle && !titlesCompatible(title, expectedTitle)) return null;
    return entry;
  } catch {
    return null;
  }
}

/** @deprecated Prefer youtubeVideoMeta */
export async function youtubeDurationMs(videoId, expectedTitle = null) {
  return youtubeVideoMeta(videoId, expectedTitle);
}

/**
 * Fill missing resolution labels.
 * Order: learned cache → title heuristics → ytimg HD thumb probe.
 * (InnerTube player formats are blocked on many LAN hosts.)
 */
export async function attachResolutions(
  items,
  { concurrency = 4, limit = 40 } = {},
) {
  const list = Array.isArray(items) ? items : [];
  applyKnownResolutions(list);
  const pending = list
    .filter((item) => item?.id && !item.resolution)
    .slice(0, Math.max(0, limit));
  let i = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, pending.length || 0) },
    async () => {
      while (i < pending.length) {
        const idx = i;
        i += 1;
        const item = pending[idx];
        try {
          let label = await resolutionFromThumb(item.id);
          if (!label) {
            label = resolutionFromText(item.title, item.channel);
          }
          if (label) {
            item.resolution = label;
            rememberResolution(item.id, label);
          }
        } catch {
          const label = resolutionFromText(item.title, item.channel);
          if (label) item.resolution = label;
        }
      }
    },
  );
  await Promise.all(workers);
  return list;
}

/** Parse "2:25" / "1:02:03" length strings from search results. */
export function parseLengthToMs(text) {
  if (!text) return null;
  const parts = String(text)
    .trim()
    .split(":")
    .map((p) => Number(p));
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return null;
  let sec = 0;
  if (parts.length === 2) sec = parts[0] * 60 + parts[1];
  else if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else return null;
  return sec * 1000;
}
