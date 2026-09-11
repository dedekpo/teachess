import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Teachess",
  description: "Play a full game of chess with every rule enforced.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-[#312e2b]">{children}</body>
    </html>
  );
}
