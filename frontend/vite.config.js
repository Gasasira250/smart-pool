import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/health": "http://127.0.0.1:5000",
      "/overview": "http://127.0.0.1:5000",
      "/tables": "http://127.0.0.1:5000",
      "/payments": "http://127.0.0.1:5000",
      "/games": "http://127.0.0.1:5000",
      "/events": {
        target: "http://127.0.0.1:5000",
        changeOrigin: true,
      },
    },
  },
});
