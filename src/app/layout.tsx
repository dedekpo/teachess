import type { Metadata } from "next";
import { Suspense } from "react";
import { LangProvider } from "@/lib/i18n/LangProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Teachess",
  description: "Play a full game of chess with every rule enforced.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html suppressHydrationWarning lang="en" className="h-full antialiased">
      <body className="min-h-full bg-[#312e2b]">
        {/* The language comes from the URL (?lang=pt-BR), so the tree under the provider renders on the client. */}
        <Suspense fallback={null}>
          <LangProvider>{children}</LangProvider>
        </Suspense>
      </body>
    </html>
  );
}
