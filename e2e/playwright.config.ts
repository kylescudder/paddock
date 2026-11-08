import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  outputDir: "../.local/emby-selection/test-results",
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: path.resolve(
          import.meta.dirname,
          "../.local/emby-selection/report",
        ),
        open: "never",
      },
    ],
  ],
  use: { baseURL: "http://localhost:4318", trace: "retain-on-failure" },
  webServer: {
    cwd: path.resolve(import.meta.dirname, ".."),
    command:
      "BETTER_AUTH_URL=http://localhost:4318 BETTER_AUTH_SECRET=fixture-secret-fixture-secret-fixture AUTH_ALLOWED_EMAILS=owner@paddock.test bunx --bun vite --config e2e/vite.config.ts --configLoader native",
    url: "http://localhost:4318/api/health",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
