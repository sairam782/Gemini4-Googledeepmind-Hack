import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS is required: the second laptop opens this over the LAN IP, and browsers only
// allow microphone access on secure origins (localhost is the only http exception).
// Set HTTPS=0 to serve plain http on localhost only.
const https = process.env.HTTPS !== "0";

export default defineConfig({
  plugins: [react(), ...(https ? [basicSsl()] : [])],
  server: {
    host: true, // listen on the LAN so the caller laptop can connect
    port: 5173,
    strictPort: true,
    fs: { allow: [".."] }, // import ../shared
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
