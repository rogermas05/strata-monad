import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  fullyParallel: false,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: "list",
});
