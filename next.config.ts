import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.112.1", "localhost", "127.0.0.1"],
  serverExternalPackages: ["ws", "unpdf"],
};

export default nextConfig;
