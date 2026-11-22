import { useMemo, useState } from "react";

function lookup(info) {
  const groups = {};
  for (const group of info?.groups || []) {
    groups[group.title] = Object.fromEntries(
      (group.rows || []).map((row) => [row.label, row.value]),
    );
  }
  return groups;
}

function gb(text) {
  const n = Number(String(text || "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return /mb/i.test(text) ? n / 1024 : n;
}

function rssiBars(text) {
  const n = Number(/-?\d+/.exec(text || "")?.[0]);
  if (!Number.isFinite(n)) return 0;
  if (n >= -50) return 4;
  if (n >= -60) return 3;
  if (n >= -70) return 2;
  return 1;
}

function toneForRssi(bars) {
  if (bars >= 3) return "good";
  if (bars === 2) return "mid";
  return "low";
}

function Mark({ name }) {
  const paths = {
    wifi: "M5 18.5c4.2-4 9.8-4 14 0M8 15.2c2.6-2.4 5.4-2.4 8 0M11 11.9c1.1-1 1.9-1 3 0M12 19.2h.01",
    picture: "M4 6.5h16v11H4zM8 16.5l2.2-2.4 1.6 1.6L15 12l3 4.5",
    chip: "M9 9h6v6H9zM9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3",
    memory: "M5 7h14v10H5zM8 7V5M12 7V5M16 7V5M8 17v2M12 17v2M16 17v2",
    system: "M12 3.5 19 7v6.2c0 3.6-2.7 6.4-7 7.3-4.3-.9-7-3.7-7-7.3V7z",
    spark: "M13 3 6 13h5l-1 8 8-12h-5z",
    volume: "M4 10h3l4-3.5v11L7 14H4zM15.5 9.2a3.6 3.6 0 0 1 0 5.6",
    light: "M12 8.2a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4M12 3.2v1.8M12 19v1.8M4.8 4.8l1.3 1.3M17.9 17.9l1.3 1.3M3.2 12h1.8M19 12h1.8M4.8 19.2l1.3-1.3M17.9 6.1l1.3-1.3",
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d={paths[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Fact({ label, value, mono = false, onCopy, copied }) {
  if (!value) return null;
  return (
    <button
      type="button"
      className={`device-fact ${copied ? "is-copied" : ""} ${mono ? "is-mono" : ""}`}
      onClick={() => onCopy(label, value)}
    >
      <span>{label}</span>
      <strong>{copied ? "Copied" : value}</strong>
    </button>
  );
}

export default function DeviceSheet({
  info,
  loading,
  error,
  state,
  onClose,
  onRefresh,
  onReset,
  resetting = false,
}) {
  const groups = useMemo(() => lookup(info), [info]);
  const net = groups.Connection || {};
  const display = groups.Display || {};
  const system = groups.System || {};
  const memory = groups.Memory || {};
  const addresses = info?.groups?.find((group) => group.title === "Addresses")?.rows || [];
  const links = info?.groups?.find((group) => group.title === "Interfaces")?.rows || [];
  const [more, setMore] = useState(false);
  const [copied, setCopied] = useState("");

  const total = gb(memory.Total);
  const free = gb(memory.Available);
  const used = total != null && free != null ? Math.max(0, total - free) : null;
  const usedPct = total && used != null ? Math.min(100, Math.round((used / total) * 100)) : null;
  const bars = rssiBars(net.RSSI);
  const awake = state?.powerOn !== false && state?.powerMode !== "standby" && state?.powerMode !== "off";
  const panel = display.Output || display.Panel;

  const copy = async (key, value) => {
    const text = String(value);
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        if (!ok) throw new Error("copy failed");
      }
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? "" : current)), 1200);
    } catch {
      setCopied("");
    }
  };

  return (
    <div className="suggest-backdrop" onClick={onClose}>
      <aside
        className="suggest-panel meta-panel device-sheet"
        role="dialog"
        aria-label="Projector details"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="suggest-head">
          <h2>Projector</h2>
          <div className="meta-actions">
            <button
              type="button"
              className={`pill ghost ${loading ? "is-busy" : ""}`}
              onClick={onRefresh}
            >
              {loading ? "Reading" : "Refresh"}
            </button>
            <button type="button" className="pill ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <button
          type="button"
          className={`device-reset ${resetting ? "is-busy" : ""}`}
          onClick={onReset}
          disabled={resetting}
        >
          {resetting ? "Resetting server state" : "Reset server state"}
        </button>

        {loading && !info ? (
          <div className="suggest-status">
            <span className="search-spinner" aria-hidden />
            Reading projector
          </div>
        ) : null}
        {error ? <div className="suggest-status">{error}</div> : null}

        {info ? (
          <div className="meta-list device-sheet-body">
            <section className="device-hero">
              <img src="/projector.png" alt="" />
              <div>
                <h3>{system.Model || "Projector"}</h3>
                <p>
                  {[system.Model, system.Android].filter(Boolean).join(" · ")}
                </p>
                <div className="device-chips">
                  <span className={`device-chip ${awake ? "is-good" : "is-idle"}`}>
                    {awake ? "Awake" : "Standby"}
                  </span>
                  {net.SSID ? <span className="device-chip">{net.SSID}</span> : null}
                  {system.Uptime ? <span className="device-chip">Up {system.Uptime}</span> : null}
                </div>
              </div>
            </section>

            <section className="device-live" aria-label="Right now">
              <div className={state?.screenOn === false ? "is-idle" : "is-good"}>
                <Mark name="picture" />
                <b>{state?.screenOn === false ? "Off" : "On"}</b>
                <span>Screen</span>
              </div>
              <div className={state?.muted ? "is-low" : "is-volume"}>
                <Mark name="volume" />
                <b>{state?.muted ? "Muted" : state?.volume ?? "–"}</b>
                <span>Volume</span>
              </div>
              <div className="is-light">
                <Mark name="light" />
                <b>
                  {state?.luminanceBoost
                    ? "Boost"
                    : state?.brightnessScale ?? state?.brightness ?? "–"}
                </b>
                <span>Light</span>
              </div>
              <div className={`is-${toneForRssi(bars || 1)}`}>
                <Mark name="wifi" />
                <b>{net["Link speed"]?.replace(" Mbps", "") || "–"}</b>
                <span>Mbps</span>
              </div>
            </section>

            <section className="device-card tone-net">
              <header>
                <i><Mark name="wifi" /></i>
                <div>
                  <h3>Network</h3>
                  <p>{net.Security || "Wi-Fi"}</p>
                </div>
                <span className={`device-signal is-${toneForRssi(bars)}`} aria-hidden>
                  {[1, 2, 3, 4].map((n) => (
                    <i key={n} className={n <= bars ? "on" : ""} />
                  ))}
                </span>
              </header>
              <Fact label="Network" value={net.SSID} onCopy={copy} copied={copied === "Network"} />
              <Fact label="Address" value={net.IP} onCopy={copy} copied={copied === "Address"} />
              <Fact label="Signal" value={net.RSSI} onCopy={copy} copied={copied === "Signal"} />
              <Fact label="Radio" value={[net.Frequency, net.Standard].filter(Boolean).join(" · ")} onCopy={copy} copied={copied === "Radio"} />
              {addresses
                .filter((row) => row.value && !String(row.value).startsWith(net.IP || "∅"))
                .map((row) => {
                  const ipv6 = /\bipv6\b/i.test(row.value);
                  const value = String(row.value).replace(/\s+ipv6$/i, "");
                  const label = ipv6 && row.label === "Tailscale" ? "IPv6" : row.label;
                  const key = `${label}-${value}`;
                  return (
                    <Fact
                      key={key}
                      label={label}
                      value={value}
                      onCopy={() => copy(key, value)}
                      copied={copied === key}
                    />
                  );
                })}
              {links.map((row) => (
                <Fact
                  key={row.label}
                  label={row.label}
                  value={row.value}
                  mono
                  onCopy={copy}
                  copied={copied === row.label}
                />
              ))}
            </section>

            <section className="device-card tone-picture">
              <header>
                <i><Mark name="picture" /></i>
                <div>
                  <h3>Picture</h3>
                  <p>{panel || "Display"}</p>
                </div>
              </header>
              <Fact label="Panel" value={display.Panel} onCopy={copy} copied={copied === "Panel"} />
              <Fact label="Output" value={display.Output} onCopy={copy} copied={copied === "Output"} />
              <Fact label="Density" value={display.Density} onCopy={copy} copied={copied === "Density"} />
              <Fact label="Graphics" value={display.Graphics} onCopy={copy} copied={copied === "Graphics"} />
            </section>

            <section className="device-card tone-memory">
              <header>
                <i><Mark name="memory" /></i>
                <div>
                  <h3>Memory</h3>
                  <p>{system.CPU || "Projector"}</p>
                </div>
              </header>
              {usedPct != null ? (
                <div className="device-meter">
                  <div className="device-meter-top">
                    <span>{used?.toFixed(1)} GB in use</span>
                    <span>{memory.Available} free</span>
                  </div>
                  <div className="device-meter-track" aria-hidden>
                    <i style={{ width: `${usedPct}%` }} />
                  </div>
                </div>
              ) : null}
              <Fact label="Total" value={memory.Total} onCopy={copy} copied={copied === "Total"} />
              <Fact label="Uptime" value={system.Uptime} onCopy={copy} copied={copied === "Uptime"} />
            </section>

            <section className="device-card tone-system">
              <header>
                <i><Mark name="system" /></i>
                <div>
                  <h3>Software</h3>
                  <p>{system.Android || "Android"}</p>
                </div>
                <button
                  type="button"
                  className="device-more"
                  aria-expanded={more}
                  onClick={() => setMore((open) => !open)}
                >
                  {more ? "Less" : "More"}
                </button>
              </header>
              <Fact label="Build" value={system.Build} onCopy={copy} copied={copied === "Build"} />
              <Fact label="Security patch" value={system["Security patch"]} onCopy={copy} copied={copied === "Security patch"} />
              <Fact label="Clock" value={system.Clock || info.clock} onCopy={copy} copied={copied === "Clock"} />
              <Fact label="Timezone" value={system.Timezone} onCopy={copy} copied={copied === "Timezone"} />
              {more ? (
                <>
                  <Fact label="Serial" value={system.Serial} mono onCopy={copy} copied={copied === "Serial"} />
                  <Fact label="Product" value={system.Product} onCopy={copy} copied={copied === "Product"} />
                  <Fact label="Hardware" value={system.Hardware} onCopy={copy} copied={copied === "Hardware"} />
                  <Fact label="Verified boot" value={system["Verified boot"]} onCopy={copy} copied={copied === "Verified boot"} />
                  <Fact label="Bootloader" value={system.Bootloader} mono onCopy={copy} copied={copied === "Bootloader"} />
                  <Fact label="Boot reason" value={system["Boot reason"]} onCopy={copy} copied={copied === "Boot reason"} />
                  <Fact label="Built" value={system.Built} onCopy={copy} copied={copied === "Built"} />
                  <Fact label="Fingerprint" value={system.Fingerprint} mono onCopy={copy} copied={copied === "Fingerprint"} />
                  {info.adb ? (
                    <Fact label="ADB" value={info.adb} mono onCopy={copy} copied={copied === "ADB"} />
                  ) : null}
                </>
              ) : null}
            </section>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
