/**
 * Standby checkpoints, measured on this projector.
 * Wake is not a boot: Android is back in under a second and the lamp follows
 * about five seconds later. Sleep is the reverse: Dozing, screen off, a short
 * ADB drop, then the lamp goes out as wakefulness becomes Asleep (~7s).
 */

export const WAKE_PROBE = [
  "echo WAKE=$(timeout 3 dumpsys power | grep -m1 mWakefulness= || true)",
  "echo LED=$(getprop vendor.xgimi.ledOn)",
  "echo AUDIO=$(getprop vendor.xgimi.audio.init.done)",
  "echo SCREEN=$(getprop debug.tracing.screen_state)",
  "echo DISP=$(timeout 3 dumpsys display | grep -m1 mScreenState= || true)",
  "echo FOCUS=$(timeout 3 dumpsys window | grep -m1 mCurrentFocus= || true)",
  "echo AF=$(settings get system xgimi_auto_focus_show)",
  "echo KF=$(settings get system xgimi_focus_show)",
].join("; ");

export const POWER_STEPS = {
  wake: [
    { id: "signal", label: "Sending wake signal" },
    { id: "link", label: "Projector answering" },
    { id: "awake", label: "Leaving sleep" },
    { id: "screen", label: "Screen on" },
    { id: "audio", label: "Audio ready" },
    { id: "light", label: "Light source on" },
    { id: "ready", label: "Controls ready" },
  ],
  reboot: [
    { id: "command", label: "Reboot requested" },
    { id: "offline", label: "Projector offline" },
    { id: "link", label: "Projector answering" },
    { id: "awake", label: "Leaving sleep" },
    { id: "screen", label: "Screen on" },
    { id: "audio", label: "Audio ready" },
    { id: "light", label: "Light source on" },
    { id: "ready", label: "Controls ready" },
  ],
  shutdown: [
    { id: "command", label: "Shutdown requested" },
    { id: "offline", label: "Projector powered off" },
  ],
  sleep: [
    { id: "signal", label: "Sending sleep" },
    { id: "dozing", label: "Dozing" },
    { id: "screen", label: "Screen off" },
    { id: "quiet", label: "Going quiet" },
    { id: "light", label: "Light off" },
    { id: "standby", label: "Standby" },
  ],
};

const TITLES = {
  wake: "Waking from standby",
  reboot: "Rebooting projector",
  shutdown: "Shutting down",
  sleep: "Going to standby",
};

function field(text, key) {
  const match = new RegExp(`^${key}=(.*)`, "m").exec(String(text || ""));
  return match ? match[1].trim() : "";
}

function focusLabel(focus) {
  const raw = String(focus || "");
  const app = /([a-zA-Z0-9._]+)\/[a-zA-Z0-9._]+/.exec(raw)?.[1] || "";
  if (!app) return "";
  if (app === "com.gathin.tvhome") return "Home";
  if (app.includes("youtube")) return "YouTube";
  const tail = app.split(".").filter(Boolean).slice(-1)[0] || app;
  return tail;
}

export function parseWakeProbe(raw) {
  const text = String(raw || "");
  const wakeLine = field(text, "WAKE");
  const wakefulness = /mWakefulness=([A-Za-z]+)/.exec(wakeLine)?.[1] || "";
  const focus = field(text, "FOCUS");
  const blocked = /dream|null/i.test(focus);
  const picture = /mCurrentFocus=Window\{/.test(focus) && !blocked;
  const af = field(text, "AF");
  const kf = field(text, "KF");
  const ledRaw = field(text, "LED");
  const audioRaw = field(text, "AUDIO");
  const screen = field(text, "SCREEN");
  const disp = field(text, "DISP");
  const screenKnown = screen !== "" || disp !== "";
  const displayOn = screen === "2" || /mScreenState=ON/.test(disp);
  return {
    wakefulness,
    awake: wakefulness === "Awake",
    led: ledRaw === "true",
    ledKnown: ledRaw !== "",
    lightOff: ledRaw !== "" && ledRaw !== "true",
    audio: audioRaw === "1",
    audioKnown: audioRaw !== "",
    displayOn,
    displayOff: screenKnown && !displayOn,
    focus,
    picture,
    focusLabel: picture ? focusLabel(focus) : "",
    focusing: af === "1" || kf === "1",
  };
}

function lightDetail(probe) {
  if (!probe) return "Waiting for the light";
  if (probe.focusing) return "Autofocus is on screen";
  if (probe.led) return "Light source on";
  return "Light source off";
}

function mark(step, ok, detail) {
  if (step.status === "done") return step;
  if (ok) return { ...step, status: "done", detail: detail || step.detail || "" };
  return { ...step, detail: detail || step.detail || "" };
}

export function evaluatePower(kind, steps, probe, flags) {
  const next = steps.map((step) => ({ ...step }));
  const set = (id, ok, detail) => {
    const step = next.find((item) => item.id === id);
    if (!step) return;
    const updated = mark(step, ok, detail);
    step.status = updated.status;
    step.detail = updated.detail;
  };

  if (kind === "shutdown") {
    set("command", !!flags.commandSent, "Shutdown command sent");
    set("offline", !!flags.offline, flags.offline ? "ADB stopped answering" : "Still connected");
  } else if (kind === "sleep") {
    const dozing = probe?.wakefulness === "Dozing" || probe?.wakefulness === "Asleep";
    const settled = probe?.wakefulness === "Asleep" && !!probe?.lightOff;
    const quietDetail = !probe && flags.sawOffline
      ? "ADB dropped"
      : probe?.led
        ? "Light still on"
        : probe
          ? "Waiting for sleep to finish"
          : "Waiting for the projector";
    set("signal", !!flags.signalSent, "Sleep key sent");
    set(
      "dozing",
      dozing,
      probe?.wakefulness
        ? `Wakefulness ${probe.wakefulness}`
        : flags.sawOffline
          ? "ADB dropped"
          : "Waiting to doze",
    );
    set(
      "screen",
      !!probe?.displayOff || settled,
      !probe && flags.sawOffline
        ? "ADB dropped"
        : probe?.displayOn
          ? "Display still on"
          : probe?.displayOff
            ? "Display off"
            : "Waiting for the screen",
    );
    set("quiet", settled, quietDetail);
    set(
      "light",
      !!(probe?.lightOff && dozing),
      probe?.led ? "Light still on" : probe?.lightOff ? "Light source off" : "Waiting for the lamp",
    );
    set(
      "standby",
      !!(
        probe?.wakefulness === "Asleep" &&
        probe.lightOff &&
        !probe.displayOn &&
        probe.audioKnown &&
        !probe.audio
      ),
      probe?.wakefulness === "Asleep"
        ? "Wakefulness Asleep, audio cleared"
        : "Waiting for sleep",
    );
  } else {
    const wake = kind === "wake";
    if (wake) set("signal", !!flags.signalSent, "Wake-on-LAN and wake key");
    else set("command", !!flags.commandSent, "Reboot command sent");
    if (!wake) {
      set(
        "offline",
        !!flags.sawOffline,
        flags.sawOffline ? "ADB dropped" : "Waiting for it to go offline",
      );
    }
    const linkOk = wake ? !!flags.linked : !!(flags.linked && flags.sawOffline);
    set("link", linkOk, flags.linked ? "ADB answered" : "Waiting for ADB");
    set(
      "awake",
      !!probe?.awake,
      probe?.wakefulness ? `Wakefulness ${probe.wakefulness}` : "Waiting to leave sleep",
    );
    set("screen", !!probe?.displayOn, probe?.displayOn ? "Display on" : "Display off");
    set(
      "audio",
      !!probe?.audio,
      probe?.audio ? "Audio path ready" : "Audio still restarting",
    );
    set("light", !!probe?.led && !probe?.focusing, lightDetail(probe));
    set(
      "ready",
      !!flags.ready,
      flags.ready ? "Volume and brightness read" : "Reading volume and brightness",
    );
  }

  let open = false;
  for (const step of next) {
    if (open) {
      if (step.status !== "error") step.status = "pending";
      continue;
    }
    if (step.status === "done") continue;
    step.status = "active";
    open = true;
  }
  return next;
}

export function powerSnapshot(kind, steps, { error = null, active = true } = {}) {
  const done = steps.filter((step) => step.status === "done").length;
  return {
    active: active && !error,
    kind,
    title: TITLES[kind] || "Projector",
    steps,
    done,
    total: steps.length,
    error,
  };
}

export function freshPowerSteps(kind) {
  return (POWER_STEPS[kind] || POWER_STEPS.wake).map((step) => ({
    ...step,
    status: "pending",
    detail: "",
  }));
}
