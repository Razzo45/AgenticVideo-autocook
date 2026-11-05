/** Official Wirestock Isolation_Mode mark from the guidebook (same asset as GDP). */
export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <img
      alt="Wirestock"
      src="/wirestock-mark.svg"
      className="brand-mark"
      width={compact ? 36 : 82}
      height={compact ? 18 : 40}
      style={{
        display: "block",
        width: compact ? 36 : 82,
        height: compact ? 18 : 40,
      }}
    />
  );
}
