import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { GeistSerif } from "geist/font/serif";
import "./globals.css";
import { Providers } from "@/components/providers";

// The same self-hosted files as packages/ui/src/styles/fonts.css (the website's @font-face).
const Inter = localFont({ variable: "--font-inter", display: "swap", weight: "100 900", src: "../../../../packages/ui/src/styles/fonts/Inter-Variable.woff2" });
const MonaSans = localFont({ variable: "--font-mona-sans", display: "swap", weight: "200 900", src: "../../../../packages/ui/src/styles/fonts/MonaSans-Variable.woff2" });
const MonaSansMono = localFont({ variable: "--font-mona-sans-mono", display: "swap", weight: "200 900", src: "../../../../packages/ui/src/styles/fonts/MonaSansMono-Variable.woff2" });

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

/** Inter for text, Mona Sans for headers, Mona Sans Mono for machine text, Geist Serif for editorial accents; globals.css maps their variables onto the font tokens. */
const fonts = [Inter.variable, MonaSans.variable, MonaSansMono.variable, GeistSerif.variable].join(" ");

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fonts} suppressHydrationWarning>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
