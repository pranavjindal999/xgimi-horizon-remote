import { useEffect, useRef, useState } from "react";

function formatTime(ms) {
  if (ms == null || Number.isNaN(ms) || ms < 0) return "–:––";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Live progress bar. Only ticks when the server has a synced position
 * (after play/seek from this remote). Unknown position shows –:––.
 */
export default function SeekBar({
  positionMs = null,
  durationMs = null,
  playing = false,
  progressAt = null,
  synced = false,
  disabled = false,
  seeking = false,
  onSeek,
}) {
  const trackRef = useRef(null);
  const [now, setNow] = useState(() => Date.now());
  const [scrub, setScrub] = useState(null);
  const [hover, setHover] = useState(null);
  const dragging = useRef(false);

  const known = synced && positionMs != null;
  const duration = Math.max(0, Number(durationMs) || 0);

  useEffect(() => {
    if (!known || !playing || seeking || scrub != null) return undefined;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [known, playing, seeking, scrub]);

  useEffect(() => {
    setNow(Date.now());
  }, [positionMs, progressAt, playing, synced]);

  let live = null;
  if (scrub != null) {
    live = scrub;
  } else if (known) {
    live = Number(positionMs) || 0;
    if (playing && progressAt && !seeking) {
      live += Math.max(0, now - Number(progressAt));
    }
    if (duration > 0) live = Math.min(duration, Math.max(0, live));
  }

  const pct = known && duration > 0 ? (live / duration) * 100 : 0;
  const canScrub = !disabled && duration > 0 && !!onSeek;

  const pointAtClientX = (clientX) => {
    const el = trackRef.current;
    if (!el || duration <= 0) return { ms: 0, ratio: 0 };
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    return { ms: Math.round(ratio * duration), ratio };
  };

  const commit = (ms) => {
    if (!canScrub) return;
    onSeek(Math.round(ms / 1000));
  };

  return (
    <div
      className={`seekbar ${disabled ? "is-disabled" : ""} ${
        known ? "" : "is-unknown"
      } ${seeking ? "is-seeking" : ""}`}
      aria-busy={seeking || undefined}
    >
      <div
        className="seekbar-track"
        ref={trackRef}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={duration || 0}
        aria-valuenow={live ?? 0}
        aria-label="Seek"
        tabIndex={canScrub ? 0 : -1}
        onPointerDown={(e) => {
          if (!canScrub) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          const point = pointAtClientX(e.clientX);
          setScrub(point.ms);
          setHover(point);
        }}
        onPointerMove={(e) => {
          if (duration <= 0) return;
          const point = pointAtClientX(e.clientX);
          if (dragging.current) setScrub(point.ms);
          setHover(point);
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          const point = pointAtClientX(e.clientX);
          setScrub(null);
          const rect = trackRef.current?.getBoundingClientRect();
          const inside =
            rect &&
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom;
          if (!inside) setHover(null);
          commit(point.ms);
        }}
        onPointerCancel={() => {
          dragging.current = false;
          setScrub(null);
          setHover(null);
        }}
        onPointerLeave={() => {
          if (!dragging.current) setHover(null);
        }}
      >
        <div className="seekbar-fill" style={{ width: `${pct}%` }} />
        {known ? (
          <div className="seekbar-thumb" style={{ left: `${pct}%` }} />
        ) : null}
        {hover && duration > 0 ? (
          <div
            className="seekbar-tip"
            style={{
              left: `clamp(22px, ${hover.ratio * 100}%, calc(100% - 22px))`,
            }}
          >
            {formatTime(hover.ms)}
          </div>
        ) : null}
      </div>
      <div className="seekbar-times">
        <span>{formatTime(live)}</span>
        {seeking ? <span className="seekbar-loading">Seeking</span> : <span />}
        <span>{formatTime(duration > 0 ? duration : null)}</span>
      </div>
    </div>
  );
}
