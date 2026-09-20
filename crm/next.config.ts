import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // The app lives inside the site's repository; without this Next traces
  // from the repository root (it finds the parent lockfile) and nests the
  // standalone server under crm/.
  outputFileTracingRoot: path.join(__dirname),
  poweredByHeader: false,
};

export default nextConfig;
