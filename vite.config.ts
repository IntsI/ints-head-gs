import { defineConfig } from "vite";

// Mirror ints-head: plain Vite + TS, host on all interfaces so a phone on the
// LAN can hit the dev server for the Gate 1 mobile fps check.
export default defineConfig({
  base: "./",
  server: { host: "0.0.0.0" },
});
