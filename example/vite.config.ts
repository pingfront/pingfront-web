// The examples on http://localhost:5204: the plain HTML page (/) loads the single-script build from
// ../dist (run `pnpm build` first), and the React page (/react/) imports the package source.
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import base from "../vite.config.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const shared = await (typeof base === "function" ? base({ mode: "development", command: "serve" }) : base);
// Both pages use your app: EXAMPLE_KEY is its public key (pk_test_… or pk_live_…, Dashboard > App > Connect), and
// the app's web origins must allow http://localhost:5204. EXAMPLE_API points them at another server than
// production (an origin, without /v1).
const key = process.env.EXAMPLE_KEY;
if (!key) throw new Error("Set EXAMPLE_KEY to your app's public key (Dashboard > App > Connect), for example EXAMPLE_KEY=pk_test_… pnpm example.");
const api = (process.env.EXAMPLE_API ?? "https://api.pingfront.sh").replace(/\/+$/, "");

export default defineConfig({
  root: here("."),
  publicDir: here("../dist"),
  define: { ...shared.define, __PF_EXAMPLE_API__: JSON.stringify(`${api}/v1`), __PF_EXAMPLE_KEY__: JSON.stringify(key) },
  plugins: [
    react(),
    { name: "example-app", transformIndexHtml: (html: string) => html.replaceAll("%PF_EXAMPLE_KEY%", key).replaceAll("%PF_EXAMPLE_API%", `${api}/v1`) },
  ],
  resolve: { alias: { "@pingfront/web-widget": here("../src/index.ts") } },
  server: { port: 5204, strictPort: true, host: "127.0.0.1" },
  preview: { port: 5204, strictPort: true },
  build: { outDir: here("../dist-example"), rollupOptions: { input: { main: here("index.html"), react: here("react/index.html") } } },
});
