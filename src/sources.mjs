const INPUTS = {
  hdmi1: "com.mediatek.tis/.HdmiInputService/HW2",
  hdmi2: "com.mediatek.tis/.HdmiInputService/HW3",
};

export const SOURCE_DUMP = [
  "timeout 4 dumpsys activity activities | grep -E 'topResumedActivity|dat=content://android.media.tv/passthrough' || true",
  "echo ===TV===",
  "timeout 4 dumpsys tv_input | grep -E 'HdmiInputService/HW|hdmi_port=' || true",
].join("; ");

export function sourceCommand(id) {
  if (id === "apps") {
    return "am start -a android.intent.action.MAIN -c android.intent.category.HOME";
  }
  const inputId = INPUTS[id];
  if (!inputId) return "";
  const segment = encodeURIComponent(inputId);
  return `am start -a android.intent.action.VIEW -d content://android.media.tv/passthrough/${segment} -t vnd.android.cursor.item/channel -n com.google.android.tv.inputplayer/.player.PassthroughPlayerActivity`;
}

/** HDMI port number on the hardware line (1 = HDMI 1). Status 1 is a plugged-in cable. */
function cableConnected(text, port) {
  const line =
    new RegExp(
      `TvInputHardwareInfo\\s*\\{[^\\n]*\\bhdmi_port=${port}\\b[^\\n]*\\}`,
    ).exec(text || "")?.[0] || "";
  const status = /cable_connection_status=(\d+)/.exec(line);
  return status ? Number(status[1]) === 1 : false;
}

export function parseSourceDump(raw) {
  const text = String(raw || "");
  const split = text.indexOf("===TV===");
  const activity = split >= 0 ? text.slice(0, split) : text;
  const tv = split >= 0 ? text.slice(split) : "";
  const top = /topResumedActivity=ActivityRecord\{[^}]*\s+(\S+\/\S+)/.exec(activity)?.[1] || "";
  const onHdmi = top.includes("PassthroughPlayerActivity");
  let current = "apps";
  if (onHdmi) {
    const dat = /dat=content:\/\/android\.media\.tv\/passthrough\/(\S+)/.exec(activity)?.[1] || "";
    const id = decodeURIComponent(dat.replace(/[^\w%./-].*$/, ""));
    if (id.includes("HW3")) current = "hdmi2";
    else if (id.includes("HW2")) current = "hdmi1";
  }
  // Input state 1 is standby and stays set with nothing plugged in.
  // cable_connection_status 1 is the only "a cable is attached" value.
  const hdmi1 = cableConnected(tv, 1);
  const hdmi2 = cableConnected(tv, 2);
  return {
    current,
    onHdmi,
    sources: [
      { id: "apps", label: "Apps", active: current === "apps" },
      { id: "hdmi1", label: "HDMI 1", active: current === "hdmi1", connected: hdmi1 },
      { id: "hdmi2", label: "HDMI 2", active: current === "hdmi2", connected: hdmi2 },
    ],
  };
}
