"use client";

/** Inline master player — native controls, no zoom lightbox. */
export function MasterVideo({
  src,
  aspect,
}: {
  src: string;
  aspect?: string;
}) {
  const vertical = aspect === "9:16";
  return (
    <div className={`master-player${vertical ? " is-vertical" : ""}`}>
      <video src={src} controls playsInline preload="metadata" />
    </div>
  );
}
