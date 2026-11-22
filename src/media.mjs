/** Parse media session + mute from dumpsys output. */

const PLAYBACK_STATE =
  /state=PlaybackState \{state=([A-Z_]+)\((\d+)\), position=(\d+), buffered position=\d+, speed=([0-9.]+), updated=(\d+)/;
const META_DURATION = /android\.media\.metadata\.DURATION[=:]\s*(\d+)/;

export function parseNowPlaying(dumpsys) {
  const text = String(dumpsys || "");
  const button =
    /Media button session is ([^\s/]+)/.exec(text)?.[1] ||
    /Audio playback[\s\S]*?uid=\d+ packages=(\S+)/.exec(text)?.[1] ||
    null;

  const sessions = [];
  const re =
    /package=(\S+)[\s\S]*?active=(true|false)[\s\S]*?(?:state=PlaybackState \{state=([A-Z_]+)\((\d+)\), position=(\d+), buffered position=\d+, speed=([0-9.]+), updated=(\d+)[^}]*\}|state=null)[\s\S]*?metadata: (?:size=\d+, description=(.+)|null)/g;
  let m;
  while ((m = re.exec(text))) {
    const pkg = m[1];
    if (pkg === "com.android.bluetooth") continue;
    const active = m[2] === "true";
    const stateName = m[3] || null;
    const stateCode = m[4] != null ? Number(m[4]) : null;
    const positionMs = m[5] != null ? Number(m[5]) : null;
    const speed = m[6] != null ? Number(m[6]) : 1;
    const positionUpdatedMs = m[7] != null ? Number(m[7]) : null;
    let title = null;
    let artist = null;
    const desc = m[8];
    if (desc && desc !== "null") {
      const parts = desc.split(", ");
      title = parts[0]?.trim() || null;
      artist = parts[1]?.trim() || null;
      if (artist === "null") artist = null;
    }
    const playing = stateName === "PLAYING" || stateCode === 3;
    const paused = stateName === "PAUSED" || stateCode === 2;
    const score =
      (button && pkg === button ? 100 : 0) +
      (playing ? 50 : 0) +
      (paused ? 20 : 0) +
      (active ? 10 : 0) +
      (title ? 5 : 0);
    sessions.push({
      package: pkg,
      title,
      artist,
      state: stateName || (playing ? "PLAYING" : paused ? "PAUSED" : "NONE"),
      playing,
      paused,
      positionMs,
      speed: Number.isFinite(speed) ? speed : 1,
      positionUpdatedMs,
      active,
      score,
    });
  }

  sessions.sort((a, b) => b.score - a.score);
  const best = sessions[0];
  const durationMatch = META_DURATION.exec(text);
  const durationMs = durationMatch ? Number(durationMatch[1]) : null;
  if (!best || best.score < 5) {
    return {
      package: button,
      title: null,
      artist: null,
      state: "NONE",
      playing: false,
      paused: false,
      positionMs: null,
      durationMs,
      speed: 1,
      positionUpdatedMs: null,
      active: false,
    };
  }
  const { score, ...rest } = best;
  return { ...rest, durationMs: durationMs ?? rest.durationMs ?? null };
}

/** Extrapolate PlaybackState position using device uptime (elapsedRealtime). */
export function extrapolatePosition(positionMs, positionUpdatedMs, speed, uptimeMs, playing) {
  if (positionMs == null || !Number.isFinite(positionMs)) return null;
  if (!playing || positionUpdatedMs == null || uptimeMs == null) return positionMs;
  const delta = (Number(uptimeMs) - Number(positionUpdatedMs)) * (Number(speed) || 1);
  if (!Number.isFinite(delta) || delta < 0) return positionMs;
  return positionMs + delta;
}

export { PLAYBACK_STATE };

export function parseMuted(audioDump) {
  const text = String(audioDump || "");
  const music =
    /- STREAM_MUSIC:([\s\S]*?)(?=\n- STREAM_|\nAudio|$)/.exec(text)?.[1] || text;
  const muted = /^\s*Muted:\s*(true|false)/m.exec(music)?.[1];
  return muted === "true";
}

export function youtubeThumb(videoId) {
  if (!videoId) return null;
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}
