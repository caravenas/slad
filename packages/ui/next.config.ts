import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @slad/shared is pure TS with no Node.js APIs — safe to transpile for client + server
  transpilePackages: ["@slad/shared"],
  // All other workspace packages use Node.js APIs (fs, crypto, etc.)
  // Mark them as server externals so Next.js resolves them at runtime, not bundle time
  serverExternalPackages: [
    "@slad/context-budget",
    "@slad/pipeline",
    "@slad/model-providers",
    "@slad/tools",
    "@slad/memory",
    "@slad/telemetry",
    "@slad/cache",
    "@slad/harness",
    "@slad/hitl",
    "@slad/agent",
    "@slad/audit-log",
  ],
};

export default nextConfig;
