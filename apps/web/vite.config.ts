import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
const root = fileURLToPath(new URL("../../", import.meta.url));
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "");
  return {
    plugins: [react()],
    envDir: root,
    server: {
      port: Number(process.env.WEB_PORT ?? env.WEB_PORT ?? 5173),
      strictPort: true,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${process.env.API_PORT ?? env.API_PORT ?? 3001}`,
          ws: true,
        },
      },
    },
    build: { chunkSizeWarningLimit: 800 },
  };
});
