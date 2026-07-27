import { useCallback, useRef } from "react";

export interface SplitterProps {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
}

const KEYBOARD_STEP = 16;

/**
 * Pointer capture rather than window listeners: the drag keeps tracking when
 * the cursor leaves the 6px handle, and releases automatically if the pointer
 * is lost, so there is no global listener left behind to leak.
 */
export function Splitter({ width, min, max, onResize }: SplitterProps) {
  const startX = useRef(0);
  const startWidth = useRef(0);

  const clamp = useCallback((n: number) => Math.min(max, Math.max(min, n)), [max, min]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      startX.current = e.clientX;
      startWidth.current = width;
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      onResize(clamp(startWidth.current + (e.clientX - startX.current)));
    },
    [clamp, onResize],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const delta = e.key === "ArrowLeft" ? -KEYBOARD_STEP : e.key === "ArrowRight" ? KEYBOARD_STEP : 0;
      if (delta === 0) return;
      e.preventDefault();
      onResize(clamp(width + delta));
    },
    [clamp, onResize, width],
  );

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize mods panel"
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onKeyDown={onKeyDown}
    />
  );
}
