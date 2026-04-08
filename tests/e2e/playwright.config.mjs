import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  fullyParallel: false,            // gens are serial; tests must be too
  workers: 1,
  timeout: 240_000,                // a single gen takes 60-90s, allow 4 min
  expect: { timeout: 30_000 },     // generous for poll-then-reload assertions
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "report.json" }]],
  use: {
    baseURL: "http://stock-gallery",   // resolved via the ollamawulf network
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
