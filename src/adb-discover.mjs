/**
 * Find the projector on the LAN for ADB — no hardcoded IP.
 *
 * Order:
 *   1. cached host (if still the right device)
 *   2. MAC → ARP/neighbour table
 *   3. already-connected `adb devices`
 *   4. scan local subnet(s) for :5555 and match serial/model
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_MAC = "";
const DEFAULT_SERIAL = "";
const DEFAULT_MODEL = "";
const ADB_PORT = 5555;

let cachedHost = null;
let cachePath = null;
let wakeIp = null;
let wakeIpPath = null;
let scanFailedAt = 0;
const SCAN_COOLDOWN_MS = 8_000;

export function configureAdbDiscover({ storagePath } = {}) {
  if (storagePath) {
    const root = storagePath.replace(/\/$/, "");
    cachePath = `${root}/adb-host.cache`;
    wakeIpPath = `${root}/wake-ip.cache`;
    try {
      const raw = fs.readFileSync(cachePath, "utf8").trim();
      if (raw) cachedHost = raw.includes(":") ? raw : `${raw}:${ADB_PORT}`;
    } catch {
      // no cache yet
    }
    try {
      const raw = fs.readFileSync(wakeIpPath, "utf8").trim();
      if (raw) wakeIp = raw.split(":")[0];
    } catch {
      // no last address yet
    }
  }
}

export function projectorLastIp() {
  return wakeIp || "";
}

function env(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

export function projectorMac() {
  return env("XGIMI_MAC", DEFAULT_MAC);
}

function normalizeMac(mac) {
  return String(mac || "")
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
}

function withPort(host) {
  if (!host) return null;
  return host.includes(":") ? host : `${host}:${ADB_PORT}`;
}

function adbEnv(adbKey) {
  const env = { ...process.env };
  if (adbKey) env.ADB_VENDOR_KEYS = adbKey;
  return env;
}

async function adb(args, adbKey, timeout = 8_000) {
  const { stdout, stderr } = await execFileAsync("adb", args, {
    env: adbEnv(adbKey),
    timeout,
    maxBuffer: 1024 * 1024,
  });
  return `${stdout}${stderr}`;
}

async function identify(host, adbKey) {
  const h = withPort(host);
  try {
    await adb(["connect", h], adbKey, 6_000);
    const out = await adb(
      ["-s", h, "shell", "getprop ro.serialno; getprop ro.product.model"],
      adbKey,
      8_000,
    );
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return { host: h, serial: lines[0] || "", model: lines[1] || "" };
  } catch {
    return null;
  }
}

function identitySet() {
  return !!(env("XGIMI_SERIAL", DEFAULT_SERIAL) || env("XGIMI_MODEL", DEFAULT_MODEL));
}

function matchesIdentity(info) {
  if (!info) return false;
  const wantSerial = env("XGIMI_SERIAL", DEFAULT_SERIAL);
  const wantModel = env("XGIMI_MODEL", DEFAULT_MODEL);
  if (!wantSerial && !wantModel) return true;
  if (wantSerial && info.serial === wantSerial) return true;
  if (wantModel && info.model === wantModel) return true;
  return false;
}

async function portOpen(ip, port = ADB_PORT, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function ipsFromNeigh(mac) {
  const want = normalizeMac(mac);
  if (!want) return [];
  try {
    const { stdout } = await execFileAsync("ip", ["neigh"], { timeout: 5_000 });
    const ips = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(
        /^([0-9.]+)\s+dev\s+\S+\s+lladdr\s+([0-9a-f:]+)/i,
      );
      if (!m) continue;
      if (normalizeMac(m[2]) === want) ips.push(m[1]);
    }
    return ips;
  } catch {
    return [];
  }
}

/** /24 of each local IPv4, plus full /22 when netmask is 255.255.252.0. */
function scanCandidates() {
  const ips = new Set();
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info.internal) continue;
      if (info.family !== "IPv4" && info.family !== 4) continue;
      const [a, b, c, d] = info.address.split(".").map(Number);
      for (let i = 1; i <= 254; i++) {
        if (i === d) continue;
        ips.add(`${a}.${b}.${c}.${i}`);
      }
      // Also neighbouring /24s when netmask is /22 (common here)
      const mask = info.netmask || "";
      if (mask === "255.255.252.0") {
        const baseC = c & 0xfc;
        for (let cc = baseC; cc < baseC + 4; cc++) {
          for (let i = 1; i <= 254; i++) {
            ips.add(`${a}.${b}.${cc}.${i}`);
          }
        }
      }
    }
  }
  return [...ips];
}

async function findOpenAdb(ips, concurrency = 64) {
  const open = [];
  for (let i = 0; i < ips.length; i += concurrency) {
    const batch = ips.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (ip) => ((await portOpen(ip)) ? ip : null)),
    );
    for (const ip of results) if (ip) open.push(ip);
  }
  return open;
}

async function fromAdbDevices(adbKey) {
  try {
    const out = await adb(["devices"], adbKey, 5_000);
    const hosts = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^([\d.]+:\d+)\s+device\b/);
      if (m) hosts.push(m[1]);
    }
    return hosts;
  } catch {
    return [];
  }
}

function remember(host) {
  cachedHost = host;
  const ip = String(host || "").split(":")[0];
  if (ip) wakeIp = ip;
  if (cachePath) {
    try {
      fs.writeFileSync(cachePath, `${host}\n`);
    } catch {
      // ignore
    }
  }
  if (wakeIpPath && ip) {
    try {
      fs.writeFileSync(wakeIpPath, `${ip}\n`);
    } catch {
      // ignore
    }
  }
}

export function invalidateAdbHost(host) {
  if (host && cachedHost === host) cachedHost = null;
  if (!host) cachedHost = null;
  if (cachePath) {
    try {
      fs.unlinkSync(cachePath);
    } catch {
      // ignore
    }
  }
}

/**
 * @returns {Promise<string>} host:port for adb -s
 */
export async function resolveAdbHost(adbKey) {
  const mac = env("XGIMI_MAC", DEFAULT_MAC);

  const tryHost = async (host, label) => {
    const info = await identify(host, adbKey);
    if (matchesIdentity(info)) {
      console.log(`ADB projector via ${label}: ${info.host} (${info.model} ${info.serial})`);
      remember(info.host);
      scanFailedAt = 0;
      return info.host;
    }
    return null;
  };

  if (cachedHost) {
    const hit = await tryHost(cachedHost, "cache");
    if (hit) return hit;
    invalidateAdbHost(cachedHost);
  }

  // Optional override still supported, but verified against identity.
  if (process.env.XGIMI_HOST) {
    const hit = await tryHost(process.env.XGIMI_HOST, "XGIMI_HOST");
    if (hit) return hit;
  }

  for (const ip of await ipsFromNeigh(mac)) {
    const hit = await tryHost(`${ip}:${ADB_PORT}`, `mac ${mac}`);
    if (hit) return hit;
  }

  const connected = await fromAdbDevices(adbKey);
  if (identitySet()) {
    for (const host of connected) {
      const hit = await tryHost(host, "adb devices");
      if (hit) return hit;
    }
  } else if (connected.length === 1) {
    const hit = await tryHost(connected[0], "adb devices");
    if (hit) return hit;
  }

  const mayScan = identitySet() || env("XGIMI_SCAN", "") === "1";
  if (!mayScan) {
    throw new Error(
      "Projector ADB not found. Set XGIMI_HOST (ip:5555) or XGIMI_MAC in .env. " +
        "A subnet scan runs only when XGIMI_SERIAL, XGIMI_MODEL, or XGIMI_SCAN=1 is set.",
    );
  }

  if (Date.now() - scanFailedAt < SCAN_COOLDOWN_MS) {
    throw new Error("Projector ADB not found. Waiting before another LAN scan.");
  }

  console.log("ADB projector: scanning LAN for :5555 …");
  const open = await findOpenAdb(scanCandidates());
  for (const ip of open) {
    const hit = await tryHost(`${ip}:${ADB_PORT}`, "scan");
    if (hit) return hit;
  }

  scanFailedAt = Date.now();
  throw new Error(
    "Projector ADB not found. Check that wireless debugging is on and .env matches this projector.",
  );
}
