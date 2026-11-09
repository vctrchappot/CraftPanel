import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { GeistSerif } from "geist/font/serif";
import "./globals.css";
import { Providers } from "@/components/providers";

const InterDisplay = localFont({
  variable: "--font-inter-display",
  display: "swap",
  src: [
    { path: "../../../../packages/ui/src/styles/fonts/InterDisplay-Regular.woff2", weight: "400", style: "normal" },
    { path: "../../../../packages/ui/src/styles/fonts/InterDisplay-Medium.woff2", weight: "500", style: "normal" },
    { path: "../../../../packages/ui/src/styles/fonts/InterDisplay-SemiBold.woff2", weight: "600", style: "normal" },
    { path: "../../../../packages/ui/src/styles/fonts/InterDisplay-Bold.woff2", weight: "700", style: "normal" },
  ],
});

export const metadata: Metadata = {
  title: { default: "CraftPanel", template: "%s · CraftPanel" },
  description: "Self-hosted Minecraft server management",
  icons: { icon: [{ url: "/favicon.ico", sizes: "48x48" }, { url: "/favicon.svg", type: "image/svg+xml" }], apple: "/apple-touch-icon.png" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f1ea" },
    { media: "(prefers-color-scheme: dark)", color: "#171614" },
  ],
};

/** Official Geist families from Vercel's `geist` package plus self-hosted Inter Display; globals.css maps their variables onto the font tokens. */
const fonts = [InterDisplay.variable, GeistSans.variable, GeistMono.variable, GeistSerif.variable].join(" ");

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fonts} suppressHydrationWarning>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
