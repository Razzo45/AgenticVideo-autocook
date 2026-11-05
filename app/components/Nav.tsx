"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "@/app/components/BrandMark";
import { ThemeToggle } from "@/app/components/ThemeToggle";

const LINKS = [
  { href: "/", label: "Cook" },
  { href: "/runs", label: "Runs" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      <Link href="/" className="nav-brand" style={{ textDecoration: "none", marginBottom: 18, display: "block" }}>
        <BrandMark />
        <span
          style={{
            display: "block",
            marginTop: 10,
            fontWeight: 600,
            letterSpacing: "0.02em",
            textTransform: "none",
            fontSize: 15,
            color: "var(--text)",
          }}
        >
          Autocook
        </span>
      </Link>
      {LINKS.map((l) => {
        const active =
          l.href === "/"
            ? path === "/"
            : l.href === "/runs"
              ? path === "/runs" || (path.startsWith("/runs/") && !path.startsWith("/runs/new"))
              : path === l.href || path.startsWith(`${l.href}/`);
        return (
          <Link key={l.href} href={l.href} className={active ? "active" : ""}>
            {l.label}
          </Link>
        );
      })}
      <div style={{ marginTop: "auto", paddingTop: 24, display: "flex", justifyContent: "flex-end" }}>
        <ThemeToggle />
      </div>
    </nav>
  );
}
