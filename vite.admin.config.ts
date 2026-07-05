import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src/admin",
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: "../../dist/admin",
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});
