import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { youtubeThumb } from "./media.mjs";

const MAX_ITEMS = 80;

function historyPath(storagePath) {
  return path.join(storagePath || ".", "youtube-history.json");
}

function normalizeItem(item = {}) {
  const id = String(item.id || item.videoId || "").trim();
  if (!id) return null;
  const title = String(item.title || "").trim() || id;
  const channel = String(item.channel || "").trim() || null;
  const length = String(item.length || "").trim() || null;
  const durationMs =
    item.durationMs != null && Number.isFinite(Number(item.durationMs))
      ? Number(item.durationMs)
      : null;
  const resolution = String(item.resolution || "").trim() || null;
  const playedAt = Number(item.playedAt) || Date.now();
  return {
    id,
    title,
    channel,
    length,
    durationMs,
    resolution,
    thumb: item.thumb || youtubeThumb(id),
    playedAt,
  };
}

async function readHistory(storagePath) {
  const file = historyPath(storagePath);
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

async function writeHistory(storagePath, items) {
  const file = historyPath(storagePath);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify({ items }, null, 2)}\n`);
  await fsp.rename(tmp, file);
}

export async function listYoutubeHistory(storagePath, { limit = 40 } = {}) {
  const items = await readHistory(storagePath);
  const n = Math.max(1, Math.min(MAX_ITEMS, Math.floor(Number(limit) || 40)));
  return items.slice(0, n);
}

/** Patch fields on an existing id without changing order or playedAt. */
export async function patchYoutubeHistoryItem(storagePath, id, fields = {}) {
  const key = String(id || "").trim();
  if (!key) return listYoutubeHistory(storagePath);
  const prev = await readHistory(storagePath);
  let changed = false;
  const merged = prev.map((row) => {
    if (row.id !== key) return row;
    const next = {
      ...row,
      title: fields.title || row.title,
      channel: fields.channel || row.channel,
      length: fields.length || row.length,
      durationMs: fields.durationMs ?? row.durationMs,
      resolution: fields.resolution || row.resolution,
      thumb: fields.thumb || row.thumb,
    };
    if (
      next.resolution !== row.resolution ||
      next.durationMs !== row.durationMs ||
      next.length !== row.length
    ) {
      changed = true;
    }
    return next;
  });
  if (changed) await writeHistory(storagePath, merged);
  return merged;
}

export async function recordYoutubePlay(storagePath, item, { force = false } = {}) {
  const next = normalizeItem({ ...item, playedAt: Date.now() });
  if (!next) {
    return { items: await listYoutubeHistory(storagePath), changed: false };
  }
  const prev = await readHistory(storagePath);
  const top = prev[0];
  // Same clip already on top from the live poll — refresh metadata only.
  if (top?.id === next.id && !force) {
    const merged = [
      {
        ...top,
        title: next.title || top.title,
        channel: next.channel || top.channel,
        length: next.length || top.length,
        durationMs: next.durationMs ?? top.durationMs,
        resolution: next.resolution || top.resolution,
        thumb: next.thumb || top.thumb,
      },
      ...prev.slice(1),
    ];
    await writeHistory(storagePath, merged);
    return { items: merged, changed: false };
  }
  const merged = [next, ...prev.filter((row) => row.id !== next.id)].slice(
    0,
    MAX_ITEMS,
  );
  await writeHistory(storagePath, merged);
  return { items: merged, changed: true };
}

export function ensureHistoryFile(storagePath) {
  const file = historyPath(storagePath);
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ items: [] }, null, 2)}\n`);
    }
  } catch {
    // first write will create it
  }
}
