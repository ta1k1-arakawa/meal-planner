import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq, req) => {
            // Translate only a genuine same-origin dev request. Foreign origins still fail on the Worker.
            if (req.headers.origin === `http://${req.headers.host}`)
              proxyReq.setHeader("Origin", "http://localhost:8787");
          });
        },
      },
    },
  },
});
