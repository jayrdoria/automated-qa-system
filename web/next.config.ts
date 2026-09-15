import type { NextConfig } from "next";

// Served behind Apache at employee.netovation.eu/automated-qa-system.
// Same pattern as Mailcraft — basePath + standalone output, Apache proxies
// the subpath through to this container's port.
const nextConfig: NextConfig = {
  basePath: "/automated-qa-system",
  assetPrefix: "/automated-qa-system",
  output: "standalone",
  devIndicators: false,
  env: {
    NEXT_PUBLIC_BASE_PATH: "/automated-qa-system",
  },
};

export default nextConfig;
