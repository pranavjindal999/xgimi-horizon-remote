import { execFile } from "node:child_process";
import dgram from "node:dgram";
import os from "node:os";
import { promisify } from "node:util";
import { magicPacket, parseState, parseWifiMac } from "./state.mjs";
import { parseWakeProbe, WAKE_PROBE } from "./wake.mjs";

const execFileAsync = promisify(execFile);
const DISPLAY = "service call xgimi.hardware.gmpf.IDisplayManager/default";

function broadcastOf(ip, netmask) {
  const parts = String(ip || "").split(".").map(Number);
  const mask = String(netmask || "").split(".").map(Number);
  if (parts.length !== 4 || mask.length !== 4) return null;
  if (parts.some((n) => !Number.isInteger(n)) || mask.some((n) => !Number.isInteger(n))) return null;
  return parts.map((part, i) => (part & mask[i]) | (255 ^ mask[i])).join(".");
}

function lanSockets() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!addrs) continue;
    if (/^(lo|docker|br-|veth|tailscale|zt)/.test(name)) continue;
    for (const addr of addrs) {
      const v4 = addr.family === "IPv4" || addr.family === 4;
      if (!v4 || addr.internal) continue;
      const broadcast = broadcastOf(addr.address, addr.netmask);
      if (!broadcast) continue;
      found.push({ from: addr.address, broadcast });
    }
  }
  return found;
}

function sendUdp(packet, from, to, port) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve();
    };
    const timer = setTimeout(done, 400);
    socket.once("error", done);
    const deliver = () => {
      try {
        socket.setBroadcast(true);
        socket.send(packet, port, to, done);
      } catch {
        done();
      }
    };
    if (from) socket.bind(0, from, deliver);
    else socket.bind(deliver);
  });
}

/** Wake-on-LAN from the LAN interface. Standby often drops ADB before the packet. */
export async function broadcastWake(mac, extraIp = "") {
  if (!mac) return;
  let packet;
  try {
    packet = magicPacket(mac);
  } catch {
    return;
  }
  const lans = lanSockets();
  const ip = String(extraIp || "").split(":")[0];
  console.log(
    `WoL ${mac} from ${lans.map((lan) => `${lan.from}->${lan.broadcast}`).join(", ") || "any"}${ip ? ` unicast ${ip}` : ""}`,
  );
  const burst = () => {
    const jobs = [];
    for (const lan of lans) {
      jobs.push(sendUdp(packet, lan.from, lan.broadcast, 9));
      jobs.push(sendUdp(packet, lan.from, lan.broadcast, 7));
      jobs.push(sendUdp(packet, lan.from, "255.255.255.255", 9));
    }
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      const from = lans[0]?.from || "";
      jobs.push(sendUdp(packet, from, ip, 9));
      jobs.push(sendUdp(packet, from, ip, 7));
    }
    if (!jobs.length) jobs.push(sendUdp(packet, "", "255.255.255.255", 9));
    return Promise.all(jobs);
  };
  await burst();
  await new Promise((r) => setTimeout(r, 150));
  await burst();
}

export class Projector {
  constructor(host, { adb = "adb" } = {}) {
    this.host = host;
    this.adb = adb;
    this.wifiMac = process.env.XGIMI_MAC || "";
    this.standingBy = false;
    this.volumeMax = 100;
  }

  async read() {
    const state = parseState(await this.#shell(this.#readCommand()));
    this.volumeMax = state.volumeMax;
    this.standingBy = !state.powerOn;
    if (!this.wifiMac) {
      try {
        this.wifiMac = parseWifiMac(await this.#shell("cmd wifi status"));
      } catch {
        this.wifiMac = null;
      }
    }
    return state;
  }

  async setScreen(on) {
    await this.#shell(`${DISPLAY} 27 i32 ${on ? 1 : 0}`);
  }

  async setBrightness(level) {
    await this.#shell(`${DISPLAY} 6 i32 ${level}; settings put global gm_projector_brightness ${level}`);
  }

  async setBoost(on) {
    await this.#shell(`${DISPLAY} 151 i32 ${on ? 1 : 0}`);
  }

  /** Brightness UI scale 1–11 where 11 = level 10 + luminance boost. */
  async setBrightnessScale(level) {
    const n = Math.max(1, Math.min(11, Number(level) || 1));
    if (n >= 11) {
      await this.setBrightness(10);
      await this.setBoost(true);
      return;
    }
    await this.setBoost(false);
    await this.setBrightness(n);
  }

  async setMuted(muted) {
    const want = !!muted;
    const dump = await this.#shell("dumpsys audio");
    const { parseMuted } = await import("./media.mjs");
    const isMuted = parseMuted(dump);
    if (isMuted === want) return;
    await this.sendKey("KEYCODE_VOLUME_MUTE");
  }

  async readVolume() {
    const text = await this.#shell("cmd media_session volume --stream 3 --get");
    const match = /volume is (\d+) in range \[(\d+)\.\.(\d+)\]/.exec(text);
    if (!match) throw new Error("Could not read the projector volume");
    const volume = Number(match[1]);
    const volumeMax = Number(match[3]);
    this.volumeMax = volumeMax;
    return { volume, volumeMax };
  }

  /**
   * Set STREAM_MUSIC in one call.
   * `cmd media_session volume --set` is rejected for adb shell. IAudioService
   * transaction 12 is setStreamVolume on this Android 14 build and applies the
   * index directly. Do not call neighboring transactions — 19 is master mute.
   */
  async setVolumeDirect(level) {
    const max = this.volumeMax || 100;
    const target = Math.max(0, Math.min(max, Math.round(Number(level) || 0)));
    // FLAG_SHOW_UI | FLAG_FROM_KEY — same overlay the projector draws for volume keys.
    const showUi = 0x1001;
    await this.#shell(
      `service call audio 12 i32 3 i32 ${target} i32 ${showUi} s16 com.android.shell`,
      8_000,
    );
    const { volume, volumeMax } = await this.readVolume();
    this.volumeMax = volumeMax;
    return volume;
  }

  /**
   * Nudge volume by at most `steps` keyevents.
   * Fallback only. The slider path uses setVolumeDirect.
   */
  async nudgeVolume(delta, { maxSteps = 4 } = {}) {
    const n = Math.max(-maxSteps, Math.min(maxSteps, Math.round(Number(delta) || 0)));
    if (n === 0) {
      const { volume } = await this.readVolume();
      return volume;
    }
    const key = n > 0 ? "KEYCODE_VOLUME_UP" : "KEYCODE_VOLUME_DOWN";
    const count = Math.abs(n);
    await this.#shell(
      `input keyevent ${Array.from({ length: count }, () => key).join(" ")}`,
      12_000,
    );
    const { volume } = await this.readVolume();
    return volume;
  }

  /** @deprecated Prefer controller-driven nudgeVolume loops. */
  async setVolume(level, { shouldAbort } = {}) {
    const target = Math.max(0, Math.min(this.volumeMax || 100, Math.round(Number(level) || 0)));
    const aborted = () => (typeof shouldAbort === "function" ? !!shouldAbort() : false);
    for (let guard = 0; guard < 40; guard += 1) {
      if (aborted()) return { aborted: true, volume: null };
      const { volume: current } = await this.readVolume();
      if (aborted()) return { aborted: true, volume: current };
      const delta = target - current;
      if (delta === 0) return { aborted: false, volume: current };
      await this.nudgeVolume(delta, { maxSteps: 4 });
    }
    const { volume: final } = await this.readVolume();
    return { aborted: aborted(), volume: final };
  }

  async setPower(on) {
    if (!on) {
      this.standingBy = true;
      try {
        await this.#shell("input keyevent KEYCODE_SLEEP");
      } catch (error) {
        if (!this.#isUnreachable(error)) throw error;
      }
      return;
    }
    await this.sendWake();
  }

  /** Wake-on-LAN plus one wake key. Further keys are sent by the progress loop. */
  async sendWake() {
    this.standingBy = false;
    if (!this.wifiMac) {
      try {
        this.wifiMac = parseWifiMac(await this.#shell("cmd wifi status", 6_000));
      } catch {
        this.wifiMac = null;
      }
    }
    await this.#wake();
    await this.nudgeWake();
  }

  async nudgeWake() {
    try {
      await this.#shell("input keyevent KEYCODE_WAKEUP", 8_000);
    } catch (error) {
      if (!this.#isUnreachable(error)) throw error;
    }
  }

  async wakeProbe(timeout = 14_000) {
    const raw = await this.#shell(WAKE_PROBE, timeout);
    return parseWakeProbe(raw);
  }

  /** `reboot` or `shutdown` via sys.powerctl. The shell may die as the device goes down. */
  async powerCtl(mode) {
    const value = mode === "reboot" ? "reboot" : "shutdown";
    try {
      await this.#shell(`setprop sys.powerctl ${value}`, 8_000);
    } catch (error) {
      if (!this.#isUnreachable(error)) throw error;
    }
  }

  readCommandPublic() {
    return this.#readCommand();
  }

  #readCommand() {
    return [
      `${DISPLAY} 28`,
      `${DISPLAY} 7`,
      `${DISPLAY} 152`,
      "cmd media_session volume --stream 3 --get",
      "dumpsys power | grep -E 'mWakefulness=|mLastSleepReason='",
    ].join("; ");
  }

  async #shell(command, timeout = 12_000) {
    await this.#connect();
    try {
      const { stdout, stderr } = await execFileAsync(this.adb, ["-s", this.host, "shell", command], {
        timeout,
      });
      return `${stdout}${stderr}`;
    } catch (error) {
      const text = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      if (text.includes("volume-unread")) {
        throw new Error("Could not read the projector volume");
      }
      if (this.#isUnreachable(error)) {
        await this.#connect();
        const { stdout, stderr } = await execFileAsync(this.adb, ["-s", this.host, "shell", command], {
          timeout,
        });
        return `${stdout}${stderr}`;
      }
      throw error;
    }
  }

  async #connect() {
    await execFileAsync(this.adb, ["connect", this.host], { timeout: 8_000 }).catch(() => {});
  }

  async #wake() {
    const ip = String(this.host || "").split(":")[0];
    await broadcastWake(this.wifiMac, ip);
  }

  async sendKey(keycode) {
    await this.#shell(`input keyevent ${keycode}`);
  }

  async sendKeys(keycodes) {
    const keys = Array.isArray(keycodes) ? keycodes.join(" ") : String(keycodes);
    if (!keys.trim()) return;
    await this.#shell(`input keyevent ${keys}`);
  }

  async mediaDispatch(action) {
    const a = String(action || "").toLowerCase();
    if (!["play", "pause", "stop", "play-pause", "fastforward", "rewind", "next", "previous"].includes(a)) {
      throw new Error(`Unknown media action: ${action}`);
    }
    await this.#shell(`cmd media_session dispatch ${a}`);
  }

  async shell(command, timeout = 12_000) {
    return this.#shell(command, timeout);
  }

  async push(localPath, remotePath) {
    await this.#connect();
    await execFileAsync(this.adb, ["-s", this.host, "push", localPath, remotePath], {
      timeout: 20_000,
    });
  }

  #isUnreachable(error) {
    const text = `${error?.message ?? ""} ${error?.stderr ?? ""} ${error?.stdout ?? ""}`;
    return /unable to connect|device offline|device unauthorized|closed|not found|timeout/i.test(text);
  }
}
