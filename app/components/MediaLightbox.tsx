"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";

type Kind = "image" | "video";

export function ZoomableMedia({
  src,
  kind,
  alt = "",
}: {
  src: string;
  kind: Kind;
  alt?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="thumb-zoom" onClick={() => setOpen(true)} title="Inspect full size">
        {kind === "image" ? <img src={src} alt={alt} /> : <video src={src} muted playsInline />}
        <span className="thumb-zoom-hint">Zoom</span>
      </button>
      {open && <MediaLightbox src={src} kind={kind} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}

function useViewportSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const r = el.getBoundingClientRect();
      setBox({ w: Math.max(0, Math.floor(r.width)), h: Math.max(0, Math.floor(r.height)) });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener("resize", apply);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, []);

  return { ref, box };
}

export function MediaLightbox({
  src,
  kind,
  alt = "",
  onClose,
}: {
  src: string;
  kind: Kind;
  alt?: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const { ref: viewportRef, box } = useViewportSize();
  const canZoom = kind === "image" || kind === "video";

  function clampScale(next: number) {
    return Math.min(8, Math.max(1, next));
  }

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (!canZoom) return;
      if (e.key === "+" || e.key === "=") setScale((s) => clampScale(s * 1.2));
      if (e.key === "-" || e.key === "_") {
        setScale((s) => {
          const next = clampScale(s / 1.2);
          if (next <= 1) setPan({ x: 0, y: 0 });
          return next;
        });
      }
      if (e.key === "0") {
        setScale(1);
        setPan({ x: 0, y: 0 });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [canZoom, onClose]);

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    setScale((s) => {
      const next = clampScale(s * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      if (next <= 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }

  function onPointerDown(e: PointerEvent) {
    if (scale <= 1) return;
    if ((e.target as HTMLElement).closest("video")) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }

  function onPointerMove(e: PointerEvent) {
    if (!drag.current) return;
    setPan({
      x: drag.current.panX + (e.clientX - drag.current.x),
      y: drag.current.panY + (e.clientY - drag.current.y),
    });
  }

  function onPointerUp() {
    drag.current = null;
  }

  const mediaStyle: CSSProperties =
    box.w > 0 && box.h > 0
      ? { maxWidth: box.w, maxHeight: box.h, width: "auto", height: "auto" }
      : { maxWidth: "100%", maxHeight: "100%", width: "auto", height: "auto" };

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-hint">Scroll to zoom · drag to pan · Esc to close</span>
        <div className="row" style={{ margin: 0 }}>
          <button type="button" onClick={() => setScale((s) => clampScale(s / 1.25))}>
            −
          </button>
          <button
            type="button"
            onClick={() => {
              setScale(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            {Math.round(scale * 100)}%
          </button>
          <button type="button" onClick={() => setScale((s) => clampScale(s * 1.25))}>
            +
          </button>
        </div>
        <button type="button" className="primary" onClick={onClose}>
          Close
        </button>
      </div>
      <div
        className={`lightbox-stage ${scale > 1 ? "zoomed" : ""}`}
        onClick={(e) => e.stopPropagation()}
        onWheel={onWheel}
      >
        <div ref={viewportRef} className="lightbox-viewport">
          <div
            className="lightbox-zoom"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {kind === "image" ? (
              <img className="lightbox-media" src={src} alt={alt} draggable={false} style={mediaStyle} />
            ) : (
              <video
                className="lightbox-media"
                src={src}
                controls
                autoPlay
                playsInline
                style={mediaStyle}
              />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
