import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { adbShell } from "./adb.mjs";

/** Only these show on the remote. */
export const ALLOWED_PACKAGES = [
  "com.google.android.youtube.tv",
  "nl.giejay.android.tv.immich",
  "com.stremio.one",
  "org.jellyfin.androidtv",
  "com.tailscale.ipn",
  "com.android.tv.settings",
  "com.android.vending",
];

const KNOWN_LABELS = {
  "com.google.android.youtube.tv": "YouTube",
  "nl.giejay.android.tv.immich": "Immich",
  "com.stremio.one": "Stremio",
  "org.jellyfin.androidtv": "Jellyfin",
  "com.tailscale.ipn": "Tailscale",
  "com.android.tv.settings": "Settings",
  "com.android.vending": "Play Store",
};

/** Preferred display order. */
const ORDER = Object.fromEntries(ALLOWED_PACKAGES.map((p, i) => [p, i]));

const PLAY_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Bundled marks. These win over a previously cached Play Store image. */
const STATIC_ICON_FILES = {
  "nl.giejay.android.tv.immich": "immich.svg",
  "org.jellyfin.androidtv": "jellyfin.svg",
  "com.tailscale.ipn": "tailscale.svg",
  "com.android.tv.settings": "settings.svg",
  "com.android.vending": "play-store.png",
};

function parseLeanbackBrief(out) {
  const apps = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-zA-Z0-9._]+)\/(\S+)/);
    if (!m) continue;
    const pkg = m[1];
    if (!ALLOWED_PACKAGES.includes(pkg)) continue;
    apps.push({
      package: pkg,
      activity: m[2],
      component: `${pkg}/${m[2]}`,
      label: KNOWN_LABELS[pkg] || pkg.split(".").pop(),
      icon: `/api/apps/icon?pkg=${encodeURIComponent(pkg)}&v=4`,
    });
  }
  const seen = new Set();
  const unique = apps.filter((a) => {
    if (seen.has(a.package)) return false;
    seen.add(a.package);
    return true;
  });
  unique.sort((a, b) => (ORDER[a.package] ?? 99) - (ORDER[b.package] ?? 99));
  return unique;
}

export async function listLeanbackApps(host, adbKey) {
  const out = await adbShell(
    host,
    adbKey,
    "cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER",
  );
  let apps = parseLeanbackBrief(out);

  // Ensure allowed apps appear even if Leanback query misses one (use MAIN activity).
  const have = new Set(apps.map((a) => a.package));
  for (const pkg of ALLOWED_PACKAGES) {
    if (have.has(pkg)) continue;
    apps.push({
      package: pkg,
      activity: "",
      component: pkg,
      label: KNOWN_LABELS[pkg],
      icon: `/api/apps/icon?pkg=${encodeURIComponent(pkg)}&v=4`,
      launchByPackage: true,
    });
  }
  apps.sort((a, b) => (ORDER[a.package] ?? 99) - (ORDER[b.package] ?? 99));
  return apps;
}

export async function launchApp(host, adbKey, component, { launchByPackage } = {}) {
  const c = String(component || "").trim();
  if (launchByPackage || !c.includes("/")) {
    const pkg = c.includes("/") ? c.split("/")[0] : c;
    await adbShell(
      host,
      adbKey,
      `monkey -p ${pkg} -c android.intent.category.LEANBACK_LAUNCHER 1`,
    );
    return { component: pkg };
  }
  const out = await adbShell(
    host,
    adbKey,
    `am start -n ${c} -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER`,
  );
  if (/Error:|Exception/i.test(out) && !/Starting:/i.test(out)) {
    await adbShell(host, adbKey, `am start -n ${c}`);
  }
  return { component: c };
}

async function fetchPlayStoreIconUrl(pkg) {
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=us`;
  const res = await fetch(url, { headers: PLAY_HEADERS });
  if (!res.ok) throw new Error(`Play Store HTTP ${res.status}`);
  const html = await res.text();
  const og = /property="og:image" content="([^"]+)"/.exec(html);
  if (!og?.[1]) throw new Error("No og:image on Play Store page");
  return og[1];
}

async function downloadToFile(url, dest) {
  const res = await fetch(url, { headers: PLAY_HEADERS });
  if (!res.ok) throw new Error(`Icon download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buf);
  return dest;
}

/**
 * Cache Play Store (or static) icon for a package. Returns absolute path.
 */
export async function ensureAppIcon(host, adbKey, pkg, cacheDir, staticDir) {
  const safe = String(pkg || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  await fsp.mkdir(cacheDir, { recursive: true });

  const staticName = STATIC_ICON_FILES[pkg];
  if (staticName && staticDir) {
    const src = path.join(staticDir, staticName);
    if (fs.existsSync(src)) return src;
  }

  for (const ext of [".svg", ".png", ".jpg", ".jpeg", ".webp"]) {
    const p = path.join(cacheDir, safe + ext);
    if (fs.existsSync(p) && fs.statSync(p).size > 200) return p;
  }

  // Play Store scrape by package name
  try {
    const iconUrl = await fetchPlayStoreIconUrl(pkg);
    const ext = iconUrl.includes(".png") ? ".png" : ".jpg";
    const dest = path.join(cacheDir, `${safe}${ext}`);
    await downloadToFile(iconUrl, dest);
    return dest;
  } catch (error) {
    console.warn(`Play Store icon failed for ${pkg}: ${error.message}`);
  }

  return null;
}

export function warmAppIcons(host, adbKey, apps, cacheDir, staticDir) {
  (async () => {
    for (const app of apps) {
      try {
        await ensureAppIcon(host, adbKey, app.package, cacheDir, staticDir);
      } catch {
        // ignore
      }
    }
  })();
}

export { KNOWN_LABELS };
