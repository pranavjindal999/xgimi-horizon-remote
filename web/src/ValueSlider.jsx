import { useCallback, useRef, useState } from "react";

/** Matches CSS thumb diameter — browsers map values across (track − thumb). */
const THUMB_PX = 34;

/**
 * Range slider that shows the value under the pointer on hover
 * (what would be set if you clicked there).
 */
export default function ValueSlider({
  label,
  ariaLabel,
  min,
  max,
  value,
  displayValue,
  /** Draw a light mark after this value. The track itself stays continuous. */
  splitAfter,
  onChange,
  /** Fired once on pointer-up / keyboard change — use for expensive device I/O. */
  onCommit,
}) {
  const trackRef = useRef(null);
  const inputRef = useRef(null);
  const [hover, setHover] = useState(null); // { value, x }
  const dragging = useRef(false);
  const lastSent = useRef(Number(value));

  if (!dragging.current) lastSent.current = Number(value);

  const format = (v) => {
    if (displayValue) return displayValue(v);
    return String(v);
  };

  const split = splitAfter != null && splitAfter > min && splitAfter < max;

  /** Native <input type="range"> maps the thumb *center* across inset track. */
  const valueAtClientX = useCallback(
    (clientX) => {
      const el = trackRef.current;
      if (!el) return min;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left;
      const usable = Math.max(1, rect.width - THUMB_PX);
      const ratio = Math.min(1, Math.max(0, (x - THUMB_PX / 2) / usable));
      return Math.round(min + ratio * (max - min));
    },
    [min, max],
  );

  const thumbCenterX = useCallback(
    (v) => {
      const el = trackRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const usable = Math.max(1, rect.width - THUMB_PX);
      const ratio = (Number(v) - min) / (max - min || 1);
      return THUMB_PX / 2 + ratio * usable;
    },
    [min, max],
  );

  const thumbCenterCss = (v) => {
    const ratio = (Number(v) - min) / (max - min || 1);
    return `calc(${THUMB_PX / 2}px + (100% - ${THUMB_PX}px) * ${ratio})`;
  };

  const showTip = (v) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = thumbCenterX(v);
    setHover({
      value: v,
      x: Math.min(rect.width, Math.max(0, x)),
    });
  };

  const emit = (next, { commit = false } = {}) => {
    showTip(next);
    if (next !== lastSent.current) {
      lastSent.current = next;
      onChange?.(next);
    }
    if (commit) onCommit?.(next);
  };

  const commitAt = (clientX, { commit = false } = {}) => {
    emit(valueAtClientX(clientX), { commit });
  };

  const shown = format(value);

  return (
    <div className="slider">
      <div className="slider-row">
        <span className="slider-icon">{label}</span>
      <div
        className="slider-track-wrap"
        ref={trackRef}
        onPointerDown={(e) => {
          if (e.button != null && e.button !== 0) return;
          // The native thumb swallows clicks that land on it, so a tap a
          // step or two away never changes the value. Set it from the pointer.
          e.preventDefault();
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          inputRef.current?.focus();
          // Preview only while dragging — device I/O waits for pointer-up.
          commitAt(e.clientX, { commit: false });
        }}
        onPointerMove={(e) => {
          if (!dragging.current) {
            showTip(valueAtClientX(e.clientX));
            return;
          }
          commitAt(e.clientX, { commit: false });
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          commitAt(e.clientX, { commit: true });
          setHover(null);
        }}
        onPointerCancel={() => {
          if (dragging.current) {
            dragging.current = false;
            onCommit?.(lastSent.current);
          }
          setHover(null);
        }}
        onPointerLeave={() => {
          if (!dragging.current) setHover(null);
        }}
      >
        {hover && (
          <div
            className="slider-tip"
            style={{ left: `${hover.x}px` }}
            aria-hidden
          >
            {format(hover.value)}
          </div>
        )}
        <input
          ref={inputRef}
          type="range"
          aria-label={ariaLabel}
          min={min}
          max={max}
          value={value}
          onChange={(e) => {
            if (dragging.current) return;
            const next = Number(e.target.value);
            emit(next, { commit: true });
          }}
        />
        {split && (
          <span
            className="slider-split"
            style={{ left: thumbCenterCss(splitAfter + 0.5) }}
            aria-hidden
          />
        )}
        <span
          className={`slider-thumb-value ${String(shown).length > 2 ? "long" : ""}`}
          style={{ left: thumbCenterCss(value) }}
          aria-hidden
        >
          {shown}
        </span>
      </div>
      </div>
    </div>
  );
}
