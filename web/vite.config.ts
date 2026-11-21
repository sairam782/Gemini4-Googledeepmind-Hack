import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Plain http by default, so nobody hits a certificate warning. Browsers only allow the microphone on
// secure origins, and localhost counts as one, so the mic works on this machine. For the two-laptop
// demo over the LAN IP, run with HTTPS=1 (self-signed certificate).
const https = process.env.HTTPS === "1"; // plain http by default; HTTPS=1 for the two-laptop mic demo over the LAN

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
