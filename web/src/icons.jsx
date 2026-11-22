function Glyph({ children, size = 22 }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function PlayIcon({ size = 20 }) {
  return (
    <Glyph size={size}>
      <path d="M8 5.2v13.6L19 12 8 5.2z" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function PauseIcon({ size = 20 }) {
  return (
    <Glyph size={size}>
      <path d="M6.8 5h3.4v14H6.8zM13.8 5h3.4v14h-3.4z" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function LoaderIcon({ size = 18 }) {
  return <span className="icon-spin" style={{ width: size, height: size }} aria-hidden />;
}

function SkipGlyph({ dir, size = 16 }) {
  const d =
    dir === "back" ? "M13 6 8 12l5 6M19 6l-5 6 5 6" : "M5 6l5 6-5 6M11 6l5 6-5 6";
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Skip backward or forward, with the seconds beside the arrows. */
export function SeekIcon({ seconds, size = 16 }) {
  const back = seconds < 0;
  const n = Math.abs(seconds);
  return (
    <span className={`seek-mark ${back ? "back" : "fwd"}`}>
      {back ? <SkipGlyph dir="back" size={size} /> : null}
      <b>{n}</b>
      {back ? null : <SkipGlyph dir="fwd" size={size} />}
    </span>
  );
}

export function MuteIcon({ muted = false, size = 22 }) {
  return (
    <Glyph size={size}>
      <path d="M4.2 9.4h2.7L11.2 5.8v12.4L6.9 14.6H4.2z" />
      {muted ? (
        <path d="M15 9.2 20.2 14.6M20.2 9.2 15 14.6" />
      ) : (
        <>
          <path d="M14.6 10a2.6 2.6 0 0 1 0 4" />
          <path d="M16.8 8a5.2 5.2 0 0 1 0 8" />
        </>
      )}
    </Glyph>
  );
}

export function VolumeIcon({ level = 0, max = 1, muted = false, size = 20 }) {
  const silent = muted || Number(level) <= 0;
  const ratio = max > 0 ? Number(level) / max : 0;
  const waves = silent ? 0 : ratio < 0.34 ? 1 : ratio < 0.67 ? 2 : 3;
  return (
    <Glyph size={size}>
      <path d="M4.2 9.4h2.7L11.2 5.8v12.4L6.9 14.6H4.2z" />
      {waves >= 1 ? <path d="M14.2 10a2.6 2.6 0 0 1 0 4" /> : null}
      {waves >= 2 ? <path d="M16.2 8a5.2 5.2 0 0 1 0 8" /> : null}
      {waves >= 3 ? <path d="M18.2 6.2a7.6 7.6 0 0 1 0 11.6" /> : null}
      {silent ? <path d="M15.2 9.2 20.4 14.6M20.4 9.2l-5.2 5.4" /> : null}
    </Glyph>
  );
}

export function SunIcon({ size = 20 }) {
  return (
    <Glyph size={size}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.2v2.1M12 18.7v2.1M4.6 4.6l1.5 1.5M17.9 17.9l1.5 1.5M3.2 12h2.1M18.7 12h2.1M4.6 19.4l1.5-1.5M17.9 6.1l1.5-1.5" />
    </Glyph>
  );
}

export function PowerIcon({ size = 22 }) {
  return (
    <Glyph size={size}>
      <path d="M12 3.2v6.4" />
      <path d="M7.2 6.5a6.8 6.8 0 1 0 9.6 0" />
    </Glyph>
  );
}

export function ScreenIcon({ size = 22 }) {
  return (
    <Glyph size={size}>
      <rect x="3.4" y="4.4" width="17.2" height="12" rx="2" />
      <path d="M8 20h8M12 16.4V20" />
    </Glyph>
  );
}

export function AppsIcon({ size = 18 }) {
  return (
    <Glyph size={size}>
      <rect x="4" y="4" width="6.2" height="6.2" rx="1.4" />
      <rect x="13.8" y="4" width="6.2" height="6.2" rx="1.4" />
      <rect x="4" y="13.8" width="6.2" height="6.2" rx="1.4" />
      <rect x="13.8" y="13.8" width="6.2" height="6.2" rx="1.4" />
    </Glyph>
  );
}

export function HdmiIcon({ size = 18 }) {
  return (
    <Glyph size={size}>
      <path d="M4.5 9.5h15v5.2a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V9.5z" />
      <path d="M8 9.5V6.2M12 9.5V6.2M16 9.5V6.2" />
    </Glyph>
  );
}

export function SearchIcon({ size = 22 }) {
  return (
    <Glyph size={size}>
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16.5 20 20.5" />
    </Glyph>
  );
}

export function CloseIcon({ size = 22 }) {
  return (
    <Glyph size={size}>
      <path d="M7 7l10 10" />
      <path d="M17 7 7 17" />
    </Glyph>
  );
}

export function HomeIcon({ size = 22 }) {
  return (
    <Glyph size={size}>
      <path d="M4 11.2 12 4.4l8 6.8" />
      <path d="M7 10.6V20h10v-9.4" />
    </Glyph>
  );
}

export function BackIcon({ size = 22 }) {
  return (
    <Glyph size={size}>
      <path d="M19 12H6" />
      <path d="M11 7 6 12l5 5" />
    </Glyph>
  );
}

export function KeyboardIcon({ size = 20 }) {
  return (
    <Glyph size={size}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M7 13h.01M10 13h4M16 13h.01" />
    </Glyph>
  );
}

export function StarIcon({ size = 16, filled = false }) {
  return (
    <Glyph size={size}>
      <path
        d="M12 3.4 14.1 8.6l5.4.4-4.1 3.5 1.3 5.3L12 15.4 7.3 17.8l1.3-5.3L4.5 9l5.4-.4L12 3.4z"
        fill={filled ? "currentColor" : "none"}
      />
    </Glyph>
  );
}

export function HistoryIcon({ size = 16 }) {
  return (
    <Glyph size={size}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.1-5.2" />
      <path d="M4.5 5.5v3.2h3.2" />
      <path d="M12 8.2V12l2.4 1.5" />
    </Glyph>
  );
}

export function ChevronIcon({ dir = "up", size = 22 }) {
  const d = {
    up: "M6 14.5 12 8.5l6 6",
    down: "M6 9.5l6 6 6-6",
    left: "M14.5 6 8.5 12l6 6",
    right: "M9.5 6 15.5 12l-6 6",
  }[dir];
  return (
    <Glyph size={size}>
      <path d={d} />
    </Glyph>
  );
}
