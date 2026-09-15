import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QA Monitor — Stakes & X7",
  description: "Automated check status for Stakes.com and X7 Casino",
  // Unauthenticated page; keep it out of search results at least.
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
