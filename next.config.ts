import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  async redirects() {
    return [
      // /live was folded into the home page. keep the old URL working
      // for shared links, RSS feeds, and OG previews on external sites.
      { source: "/live", destination: "/", permanent: true },
    ];
  },
};

export default nextConfig;
