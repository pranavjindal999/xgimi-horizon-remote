const PROPS = [
  "ro.product.model",
  "ro.product.name",
  "ro.product.device",
  "ro.product.manufacturer",
  "ro.build.version.release",
  "ro.build.version.sdk",
  "ro.build.version.security_patch",
  "ro.build.display.id",
  "ro.build.version.incremental",
  "ro.build.fingerprint",
  "ro.serialno",
  "ro.hardware",
  "ro.boot.slot_suffix",
  "ro.boot.verifiedbootstate",
  "ro.boot.vbmeta.device_state",
  "ro.bootloader",
  "ro.build.type",
  "ro.build.tags",
  "persist.sys.timezone",
  "ro.opengles.version",
  "ro.product.cpu.abi",
  "ro.boot.bootreason",
  "ro.build.date",
];

const SECURITY = {
  0: "Open",
  1: "WPA2-PSK",
  2: "WPA-EAP",
  3: "802.1X",
  4: "WPA3-SAE",
  5: "OWE",
  6: "WPA3-Enterprise",
};

const KEEP_IFACE = new Set(["wlan0", "eth0", "p2p0", "ap0"]);

export const DEVICE_SHELL = [
  "echo ===WIFI===",
  "cmd wifi status",
  "echo ===IP===",
  "ip -o addr",
  "echo ===LINK===",
  "ip -o link",
  "echo ===PROPS===",
  ...PROPS.map((key) => `echo ${key}=$(getprop ${key})`),
  "echo ===UPTIME===",
  "cat /proc/uptime",
  "echo ===MEM===",
  "grep -E 'MemTotal|MemAvailable' /proc/meminfo",
  "echo ===CPU===",
  "nproc",
  "echo ===DISPLAY===",
  "wm size",
  "wm density",
  "echo ===DATE===",
  "date",
].join("; ");

function sections(raw) {
  const out = {};
  let name = "";
  for (const line of String(raw || "").split(/\r?\n/)) {
    const mark = /^===([A-Z]+)===$/.exec(line.trim());
    if (mark) {
      name = mark[1];
      out[name] = "";
      continue;
    }
    if (!name) continue;
    out[name] += `${line}\n`;
  }
  return out;
}

function grab(text, re) {
  return re.exec(text || "")?.[1]?.trim() || "";
}

function row(label, value) {
  const text = String(value ?? "").trim();
  if (!text || text === "null") return null;
  return { label, value: text };
}

function rows(...items) {
  return items.filter(Boolean);
}

function kbLabel(kb) {
  const n = Number(kb);
  if (!Number.isFinite(n) || n <= 0) return "";
  const gb = n / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(n / 1024)} MB`;
}

function uptimeLabel(seconds) {
  const total = Math.floor(Number(seconds) || 0);
  if (total <= 0) return "";
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${mins}m`].filter(Boolean).join(" ");
}

function channelFor(mhz) {
  const freq = Number(mhz);
  if (!freq) return "";
  if (freq === 2484) return "14";
  if (freq >= 2412 && freq <= 2472) return String(Math.round((freq - 2407) / 5));
  if (freq >= 5000 && freq <= 5900) return String(Math.round((freq - 5000) / 5));
  return "";
}

function glLabel(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "";
  const major = n >> 16;
  const minor = n & 0xffff;
  return major ? `OpenGL ES ${major}.${minor}` : "";
}

function parseWifi(text) {
  const info = text || "";
  const ssid = grab(info, /SSID:\s*"([^"]*)"/);
  const securityType = grab(info, /Security type:\s*(\d+)/);
  const named = /wpa3-sae|wpa2-psk|wpa-eap|owe/i.exec(info)?.[0] || "";
  const security = named
    ? named.toUpperCase().replace("WPA3-SAE", "WPA3-SAE")
    : SECURITY[securityType] || "";
  const mhz = grab(info, /Frequency:\s*(\d+)MHz/i);
  const channel = channelFor(mhz);
  return rows(
    row("SSID", ssid),
    row("BSSID", grab(info, /BSSID:\s*([0-9A-Fa-f:]{17})/)),
    row("Wi-Fi MAC", grab(info, /MAC:\s*([0-9A-Fa-f:]{17})/)),
    row("IP", grab(info, /IP:\s*\/?([0-9.]+)/)),
    row("Security", security),
    row("Standard", grab(info, /Wi-Fi standard:\s*(\d+)/) ? `Wi-Fi ${grab(info, /Wi-Fi standard:\s*(\d+)/)}` : ""),
    row("RSSI", grab(info, /RSSI:\s*(-?\d+)/) ? `${grab(info, /RSSI:\s*(-?\d+)/)} dBm` : ""),
    row("Link speed", grab(info, /Link speed:\s*(\d+)Mbps/i) ? `${grab(info, /Link speed:\s*(\d+)Mbps/i)} Mbps` : ""),
    row("Frequency", mhz ? `${mhz} MHz${channel ? ` · ch ${channel}` : ""}` : ""),
    row("Score", grab(info, /score:\s*(\d+)/)),
  );
}

function parseAddresses(text) {
  const list = [];
  for (const line of String(text || "").split("\n")) {
    const match = /^\d+:\s+(\S+)\s+(inet6|inet)\s+(\S+)/.exec(line.trim());
    if (!match) continue;
    const [, iface, kind, addr] = match;
    if (iface === "lo" || iface.startsWith("dummy")) continue;
    if (addr.startsWith("fe80:")) continue;
    const address = addr.split("/")[0];
    const prefix = addr.includes("/") ? `/${addr.split("/")[1]}` : "";
    const label =
      iface === "tun1" ? "Tailscale" : iface === "wlan0" ? "Wi-Fi" : iface;
    list.push(row(label, `${address}${prefix}` + (kind === "inet6" ? "  IPv6" : "")));
  }
  return list;
}

function parseLinks(text) {
  const list = [];
  for (const line of String(text || "").split("\n")) {
    const match = /^\d+:\s+([^:@\s]+).*?\bstate\s+(\S+).*?\blink\/ether\s+([0-9a-f:]{17})/i.exec(line.trim());
    if (!match) continue;
    const [, name, state, mac] = match;
    if (!KEEP_IFACE.has(name)) continue;
    const label = { wlan0: "wlan0", eth0: "Ethernet", p2p0: "Wi-Fi Direct", ap0: "Hotspot" }[name] || name;
    list.push(row(label, `${mac} · ${state}`));
  }
  return list;
}

function parseProps(text) {
  const props = {};
  for (const line of String(text || "").split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    props[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return props;
}

function parseDisplay(text) {
  return {
    physical: grab(text, /Physical size:\s*(\d+x\d+)/),
    override: grab(text, /Override size:\s*(\d+x\d+)/),
    density: grab(text, /Physical density:\s*(\d+)/),
  };
}

export function parseDeviceDump(raw) {
  const part = sections(raw);
  const props = parseProps(part.PROPS);
  const mem = part.MEM || "";
  const display = parseDisplay(part.DISPLAY);
  const cores = grab(part.CPU, /(\d+)/);
  const uptime = uptimeLabel(grab(part.UPTIME, /^([\d.]+)/m));
  const boot = [props["ro.boot.verifiedbootstate"], props["ro.boot.vbmeta.device_state"]]
    .filter(Boolean)
    .join(" · ");

  return {
    ok: true,
    clock: (part.DATE || "").trim(),
    groups: [
      { title: "Connection", rows: parseWifi(part.WIFI) },
      { title: "Addresses", rows: parseAddresses(part.IP) },
      { title: "Interfaces", rows: parseLinks(part.LINK) },
      {
        title: "Display",
        rows: rows(
          row("Panel", display.physical),
          row("Output", display.override),
          row("Density", display.density ? `${display.density} dpi` : ""),
          row("Graphics", glLabel(props["ro.opengles.version"])),
        ),
      },
      {
        title: "System",
        rows: rows(
          row("Model", props["ro.product.model"]),
          row("Product", props["ro.product.name"]),
          row("Device", props["ro.product.device"]),
          row("Maker", props["ro.product.manufacturer"]),
          row(
            "Android",
            [props["ro.build.version.release"], props["ro.build.version.sdk"] && `SDK ${props["ro.build.version.sdk"]}`]
              .filter(Boolean)
              .join(" · "),
          ),
          row("Build", props["ro.build.display.id"]),
          row("Incremental", props["ro.build.version.incremental"]),
          row("Security patch", props["ro.build.version.security_patch"]),
          row("Serial", props["ro.serialno"]),
          row("Hardware", props["ro.hardware"]),
          row("CPU", [cores && `${cores} cores`, props["ro.product.cpu.abi"]].filter(Boolean).join(" · ")),
          row("Boot slot", props["ro.boot.slot_suffix"]),
          row("Verified boot", boot),
          row("Bootloader", props["ro.bootloader"]),
          row("Build type", [props["ro.build.type"], props["ro.build.tags"]].filter(Boolean).join(" · ")),
          row("Boot reason", props["ro.boot.bootreason"]),
          row("Built", props["ro.build.date"]),
          row("Uptime", uptime),
          row("Timezone", props["persist.sys.timezone"]),
          row("Clock", (part.DATE || "").trim()),
          row("Fingerprint", props["ro.build.fingerprint"]),
        ),
      },
      {
        title: "Memory",
        rows: rows(
          row("Total", kbLabel(grab(mem, /MemTotal:\s*(\d+)/))),
          row("Available", kbLabel(grab(mem, /MemAvailable:\s*(\d+)/))),
        ),
      },
    ].filter((group) => group.rows.length),
  };
}
