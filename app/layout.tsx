import "./globals.css";
import Script from "next/script";
import { Nav } from "@/app/components/Nav";
import { ThemeSync } from "@/app/components/ThemeToggle";

export const metadata = {
  title: "Wirestock Autocook",
  description: "Paste a task, COOK, download the master — Argon + Omni on Gemini",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Script id="autocook-theme" strategy="beforeInteractive">
          {`try{var t=localStorage.getItem('autocook-theme');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`}
        </Script>
        <ThemeSync />
        <div className="app">
          <Nav />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
