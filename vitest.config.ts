import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["services/*/test/**/*.test.ts", "packages/contracts/test/**/*.test.ts"],
    // Live-RPC integration tests are opt-in: `LIVE_RPC=1 pnpm test`.
    // CI must stay green when Fuji is having a bad day.
    environment: "node",
  },
});
