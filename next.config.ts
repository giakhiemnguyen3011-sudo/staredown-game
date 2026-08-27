import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep default; MediaPipe loads WASM from CDN via fetch, no COOP/COEP needed for Vercel
};

export default nextConfig;
