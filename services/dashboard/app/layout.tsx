import type { ReactNode } from "react";
import Link from "next/link";

export const metadata = {
  title: "StraitsX — Mandated Payments",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        <nav
          style={{
            display: "flex",
            gap: "1.5rem",
            padding: "1rem 2rem",
            borderBottom: "1px solid #ddd",
            fontSize: "0.95rem",
          }}
        >
          <Link href="/">Run</Link>
          <Link href="/mandates">Mandates</Link>
          <Link href="/runs">Runs</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
