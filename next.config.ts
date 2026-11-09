import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [],
  experimental: {
    // Backup for any route that still passes through middleware.
    middlewareClientMaxBodySize: "5gb",
  },
};

export default nextConfig;
