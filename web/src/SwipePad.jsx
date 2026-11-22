import { useRef, useState } from "react";
import { ChevronIcon } from "./icons.jsx";

/**
 * Touch / pointer swipe pad for mobile D-pad.
 * Flick in a direction → send that key (with optional hold-repeat while held past threshold).
 */
export default function SwipePad({ onDirection, onOk }) {
  const origin = useRef(null);
  const lastDir = useRef(null);
  const repeatRef = useRef(null);
  const [active, setActive] = useState(null); // up|down|left|right|ok|null
  const [ring, setRing] = useState({ x: 0, y: 0, show: false });

  const THRESHOLD = 28;

  const clearRepeat = () => {
    if (repeatRef.current) {
      clearInterval(repeatRef.current);
      repeatRef.current = null;
    }
  };

  const dirFromDelta = (dx, dy) => {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax < THRESHOLD && ay < THRESHOLD) return null;
    if (ax > ay) return dx > 0 ? "right" : "left";
    return dy > 0 ? "down" : "up";
  };

  const fireDir = (dir) => {
    if (!dir) return;
    lastDir.current = dir;
    setActive(dir);
    onDirection?.(dir);
  };

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    origin.current = { x: e.clientX, y: e.clientY, moved: false };
    lastDir.current = null;
    clearRepeat();
    setRing({ x: e.clientX, y: e.clientY, show: true });
    setActive(null);
  };

  const onPointerMove = (e) => {
    if (!origin.current) return;
    const dx = e.clientX - origin.current.x;
    const dy = e.clientY - origin.current.y;
    const dir = dirFromDelta(dx, dy);
    setRing({
      x: e.clientX,
      y: e.clientY,
      show: true,
      dx,
      dy,
    });
    if (!dir) return;
    origin.current.moved = true;
    if (dir !== lastDir.current) {
      fireDir(dir);
      clearRepeat();
      repeatRef.current = setInterval(() => onDirection?.(dir), 140);
    }
  };

  const onPointerUp = (e) => {
    if (!origin.current) return;
    const dx = e.clientX - origin.current.x;
    const dy = e.clientY - origin.current.y;
    const moved = origin.current.moved || Math.hypot(dx, dy) >= THRESHOLD;
    clearRepeat();
    origin.current = null;
    setRing((r) => ({ ...r, show: false }));
    if (!moved) {
      setActive("ok");
      onOk?.();
      setTimeout(() => setActive(null), 120);
      return;
    }
    setTimeout(() => setActive(null), 120);
  };

  return (
    <div
      className={`swipe-pad ${active ? `dir-${active}` : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="application"
      aria-label="Swipe pad. Swipe for directions, tap for OK."
    >
      <div className="swipe-compass" aria-hidden>
        <span className={`arm up ${active === "up" ? "on" : ""}`}>
          <ChevronIcon dir="up" />
        </span>
        <span className={`arm left ${active === "left" ? "on" : ""}`}>
          <ChevronIcon dir="left" />
        </span>
        <span className={`arm ok ${active === "ok" ? "on" : ""}`}>OK</span>
        <span className={`arm right ${active === "right" ? "on" : ""}`}>
          <ChevronIcon dir="right" />
        </span>
        <span className={`arm down ${active === "down" ? "on" : ""}`}>
          <ChevronIcon dir="down" />
        </span>
      </div>
      <div className="swipe-hint">Swipe to move · tap for OK</div>
      {ring.show && (
        <div
          className="swipe-finger"
          style={{
            left: `${ring.x}px`,
            top: `${ring.y}px`,
          }}
        />
      )}
    </div>
  );
}
