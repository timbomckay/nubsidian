import { build } from "esbuild";

await build({
  entryPoints: ["src/editor.js"],
  bundle: true,
  minify: true,
  format: "iife",
  outfile: "public/editor.bundle.js",
  logLevel: "info",
});
