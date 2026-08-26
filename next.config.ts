import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  allowedDevOrigins: ["*.space-z.ai", "*.chatglm.cn"],
  // Type errors MUST block production builds — `tsc --noEmit` is clean
  // (tsconfig excludes standalone scripts/tests). Never re-enable
  // ignoreBuildErrors; it hides real regressions.
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: false,
};

export default nextConfig;
