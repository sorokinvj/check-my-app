/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // The worker runs Playwright/BullMQ in a separate process; keep them out of the bundle.
    serverComponentsExternalPackages: ["playwright", "bullmq", "ioredis"],
  },
};

export default nextConfig;
