const HEX = new Set("0123456789abcdefABCDEF");
const VOLUME = /volume is (\d+) in range \[(\d+)\.\.(\d+)\]/;
const WAKE = /mWakefulness=([A-Za-z]+)/;
const SLEEP_REASON = /mLastSleepReason=([A-Za-z0-9_]+)/;
const MAC = /MAC: ([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/;
const ASLEEP = new Set(["Asleep", "Dozing", "GoingToSleep", "Sleeping"]);

export const BRIGHTNESS_MIN = 1;
export const BRIGHTNESS_MAX = 10;
export const MATTER_LEVEL_MAX = 254;

export function parcelValues(response) {
  if (!response.includes("Parcel")) {
    throw new Error(`Unexpected projector reply: ${response}`);
  }
  const values = [];
  for (const chunk of response.split("Parcel").slice(1)) {
    const words = chunk
      .replaceAll("(", " ")
      .replaceAll(")", " ")
      .split(/\s+/)
      .filter((token) => token.length === 8 && [...token].every((char) => HEX.has(char)));
    if (words.length < 2) {
      throw new Error(`Unexpected projector reply: ${response}`);
    }
    values.push(Number.parseInt(words[1], 16));
  }
  if (values.length === 0) {
    throw new Error(`Unexpected projector reply: ${response}`);
  }
  return values;
}

export function parseVolume(response) {
  const match = VOLUME.exec(response);
  if (!match) {
    throw new Error(`Unexpected volume reply: ${response}`);
  }
  const volume = Number(match[1]);
  const low = Number(match[2]);
  const high = Number(match[3]);
  if (high < low || volume < low || volume > high) {
    throw new Error(`Unexpected volume reply: ${response}`);
  }
  return { volume, volumeMax: high };
}

export function parsePowerOn(response) {
  const wake = WAKE.exec(response);
  if (!wake) {
    throw new Error(`Unexpected power reply: ${response}`);
  }
  const state = wake[1];
  const reason = SLEEP_REASON.exec(response)?.[1] ?? "";
  if (state === "Awake") return true;
  if (state === "Dreaming") return reason !== "power_button";
  if (ASLEEP.has(state)) return false;
  throw new Error(`Unexpected wakefulness: ${state}`);
}

export function parseWifiMac(response) {
  return MAC.exec(response)?.[1].toLowerCase() ?? null;
}

export function parseState(response) {
  const values = parcelValues(response);
  if (values.length !== 3) {
    throw new Error(`Expected three projector replies, got ${values.length}`);
  }
  const [screen, level, boost] = values;
  if (level < BRIGHTNESS_MIN || level > BRIGHTNESS_MAX) {
    throw new Error(`Unexpected brightness level: ${level}`);
  }
  if (boost !== 0 && boost !== 1) {
    throw new Error(`Unexpected luminance boost state: ${boost}`);
  }
  const { volume, volumeMax } = parseVolume(response);
  return {
    screenOn: screen === 1,
    brightness: level,
    luminanceBoost: boost === 1,
    volume,
    volumeMax,
    powerOn: parsePowerOn(response),
  };
}

export function brightnessToLevel(brightness) {
  const clamped = Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, brightness));
  return Math.round((clamped / BRIGHTNESS_MAX) * MATTER_LEVEL_MAX);
}

export function levelToBrightness(level) {
  if (level == null || level <= 0) return BRIGHTNESS_MIN;
  const scaled = Math.round((level / MATTER_LEVEL_MAX) * BRIGHTNESS_MAX);
  return Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, scaled));
}

export function volumeToLevel(volume, volumeMax) {
  const clamped = Math.min(volumeMax, Math.max(0, volume));
  if (volumeMax <= 0 || clamped === 0) return 0;
  return Math.round((clamped / volumeMax) * MATTER_LEVEL_MAX);
}

export function levelToVolume(level, volumeMax) {
  if (level == null || level <= 0) return 0;
  const scaled = Math.round((level / MATTER_LEVEL_MAX) * volumeMax);
  return Math.min(volumeMax, Math.max(0, scaled));
}

export function magicPacket(mac) {
  const parts = mac.split(":");
  if (parts.length !== 6 || parts.some((part) => !/^[0-9a-fA-F]{2}$/.test(part))) {
    throw new Error(`Unexpected MAC address: ${mac}`);
  }
  const hardware = Buffer.from(parts.map((part) => Number.parseInt(part, 16)));
  return Buffer.concat([Buffer.alloc(6, 0xff), Buffer.concat(Array.from({ length: 16 }, () => hardware))]);
}
