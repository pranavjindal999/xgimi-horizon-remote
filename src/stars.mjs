import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { youtubeThumb } from "./media.mjs";

const MAX_ITEMS = 80;

function starsPath(storagePath) {
  return path.join(storagePath || ".", "youtube-stars.json");
}

function normalizeItem(item = {}) {
  const id = String(item.id || item.videoId || "").trim();
  if (!id) return null;
  const title = String(item.title || "").trim() || id;
  const channel = String(item.channel || item.artist || "").trim() || null;
  const length = String(item.length || "").trim() || null;
  const durationMs =
    item.durationMs != null && Number.isFinite(Number(item.durationMs))
      ? Number(item.durationMs)
      : null;
  const resolution = String(item.resolution || "").trim() || null;
  const starredAt = Number(item.starredAt) || Date.now();
  return {
    id,
    title,
    channel,
    length,
    durationMs,
    resolution,
    thumb: item.thumb || youtubeThumb(id),
    starredAt,
  };
}

async function readStars(storagePath) {
  const file = starsPath(storagePath);
  try {
    const raw = await fsp.readFile(file, "utf8");
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : data?.items;
    if (!Array.isArray(list)) return [];
    return list.map(normalizeItem).filter(Boolean);
  } catch {
    return [];
  }
}

async function writeStars(storagePath, items) {
  const file = starsPath(storagePath);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify({ items }, null, 2)}\n`);
  await fsp.rename(tmp, file);
}

export async function listYoutubeStars(storagePath, { limit = 40 } = {}) {
  const items = await readStars(storagePath);
  const n = Math.max(1, Math.min(MAX_ITEMS, Math.floor(Number(limit) || 40)));
  return items.slice(0, n);
}

export async function starYoutube(storagePath, item) {
  const next = normalizeItem({ ...item, starredAt: Date.now() });
  if (!next) {
    return { items: await listYoutubeStars(storagePath), changed: false };
  }
  const prev = await readStars(storagePath);
  const merged = [next, ...prev.filter((row) => row.id !== next.id)].slice(0, MAX_ITEMS);
  await writeStars(storagePath, merged);
  return { items: merged, changed: true };
}

export async function unstarYoutube(storagePath, id) {
  const key = String(id || "").trim();
  const prev = await readStars(storagePath);
  const merged = prev.filter((row) => row.id !== key);
  if (merged.length !== prev.length) await writeStars(storagePath, merged);
  return { items: merged, changed: merged.length !== prev.length };
}

export function ensureStarsFile(storagePath) {
  const file = starsPath(storagePath);
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ items: [] }, null, 2)}\n`);
    }
  } catch {
    // first write will create it
  }
}
