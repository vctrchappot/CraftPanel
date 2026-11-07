import type { NextConfig } from "next";

// The dashboard is a static client-side app served by the CraftPanel API
// process, so one port serves both. In development the API runs separately.
const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@craftpanel/shared", "@craftpanel/ui"],
  reactStrictMode: true,
  devIndicators: false,
};

export default config;
