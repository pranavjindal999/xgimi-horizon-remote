/** Named remote keys → Android keyevent codes / media_session actions */

export const KEY_MAP = {
  up: "KEYCODE_DPAD_UP",
  down: "KEYCODE_DPAD_DOWN",
  left: "KEYCODE_DPAD_LEFT",
  right: "KEYCODE_DPAD_RIGHT",
  ok: "KEYCODE_DPAD_CENTER",
  enter: "KEYCODE_ENTER",
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  menu: "KEYCODE_MENU",
  mute: "KEYCODE_VOLUME_MUTE",
  volume_up: "KEYCODE_VOLUME_UP",
  volume_down: "KEYCODE_VOLUME_DOWN",
  play: "KEYCODE_MEDIA_PLAY",
  pause: "KEYCODE_MEDIA_PAUSE",
  play_pause: "KEYCODE_MEDIA_PLAY_PAUSE",
  stop: "KEYCODE_MEDIA_STOP",
  next: "KEYCODE_MEDIA_NEXT",
  previous: "KEYCODE_MEDIA_PREVIOUS",
  rewind: "KEYCODE_MEDIA_REWIND",
  fast_forward: "KEYCODE_MEDIA_FAST_FORWARD",
  sleep: "KEYCODE_SLEEP",
  wakeup: "KEYCODE_WAKEUP",
  search: "KEYCODE_SEARCH",
};

export function keyeventFor(name) {
  const key = KEY_MAP[String(name || "").toLowerCase()];
  if (!key) throw new Error(`Unknown key: ${name}`);
  return key;
}

/** Approximate media seek: each REWIND/FF keyevent ~5s on many players. */
export function seekKeyBurst(seconds) {
  const sec = Number(seconds) || 0;
  if (!sec) return null;
  const steps = Math.max(1, Math.round(Math.abs(sec) / 5));
  const code = sec < 0 ? "KEYCODE_MEDIA_REWIND" : "KEYCODE_MEDIA_FAST_FORWARD";
  return Array.from({ length: steps }, () => code).join(" ");
}
