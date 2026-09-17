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
  // With basePath set, "/" is not served at all — it 404s, which reads like a
  // broken app rather than a wrong URL. `basePath: false` makes this redirect
  // apply to the true root instead of being rewritten under the basePath.
  async redirects() {
    return [
      {
        source: "/",
        destination: "/automated-qa-system",
        basePath: false,
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
