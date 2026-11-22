import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { invalidateAdbHost, resolveAdbHost } from "./adb-discover.mjs";

const execFileAsync = promisify(execFile);

function adbEnv(adbKey) {
  const env = { ...process.env };
  if (adbKey) env.ADB_VENDOR_KEYS = adbKey;
  return env;
}

export async function adbConnect(host, adbKey) {
  await execFileAsync("adb", ["connect", host], {
    env: adbEnv(adbKey),
    timeout: 8_000,
  }).catch(() => {});
}

export async function adbShell(host, adbKey, command, timeout = 20_000) {
  const env = adbEnv(adbKey);
  await adbConnect(host, adbKey);
  try {
    const { stdout, stderr } = await execFileAsync(
      "adb",
      ["-s", host, "shell", command],
      { env, timeout, maxBuffer: 8 * 1024 * 1024 },
    );
    return `${stdout}${stderr}`;
  } catch (error) {
    const text = `${error?.message ?? ""} ${error?.stderr ?? ""} ${error?.stdout ?? ""}`;
    if (/unable to connect|device offline|not found|closed|timeout/i.test(text)) {
      invalidateAdbHost(host);
      const next = await resolveAdbHost(adbKey);
      await adbConnect(next, adbKey);
      const { stdout, stderr } = await execFileAsync(
        "adb",
        ["-s", next, "shell", command],
        { env, timeout, maxBuffer: 8 * 1024 * 1024 },
      );
      return `${stdout}${stderr}`;
    }
    throw error;
  }
}

export async function adbPullBytes(host, adbKey, remotePath) {
  const env = adbEnv(adbKey);
  await adbConnect(host, adbKey);
  const { stdout } = await execFileAsync(
    "adb",
    ["-s", host, "exec-out", "cat", remotePath],
    { env, timeout: 30_000, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout;
}

export { resolveAdbHost, invalidateAdbHost };
