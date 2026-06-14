/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;

// OpenNext/Cloudflare: lets getCloudflareContext() resolve bindings under
// `next dev` too (no-op in production builds). `wrangler dev` gets bindings
// from wrangler.jsonc directly and doesn't need this.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
