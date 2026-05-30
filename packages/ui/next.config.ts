import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@slad/shared",
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
