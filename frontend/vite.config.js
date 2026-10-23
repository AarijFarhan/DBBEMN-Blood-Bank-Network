import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    base: "/",
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        "/api/v1": {
          target: env.VITE_API_PROXY_TARGET || "http://127.0.0.1",
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        output: {
          // Recharts and Leaflet are only needed by the dashboard and map
          // routes. Splitting them keeps the first paint (auth + search) small
          // and lets a returning visitor cache the heavy vendor code separately.
          manualChunks(id) {
            if (
              id.includes("node_modules/recharts") ||
              id.includes("node_modules/d3-") ||
              id.includes("node_modules/victory-vendor")
            ) {
              return "charts";
            }
            if (id.includes("node_modules/leaflet")) {
              return "map";
            }
            return undefined;
          },
        },
      },
    },
  };
});
