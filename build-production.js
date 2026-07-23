// Assemble a self-contained, ready-to-run app into `dist/`.
//
// Unlike `build.js` (which only bundles the TipTap editor for local dev),
// this also bundles the *server* — fastify, @fastify/static and chokidar —
// into a single file with no dependencies. The result runs with just
// `node server.js`: no `npm install`, no `node_modules`. The `production`
// branch is this `dist/` directory, published by .github/workflows/production.yml.

import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "dist");

// Start from a clean dist so stale files never linger.
await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(path.join(dist, "public"), { recursive: true });

// 1. Editor bundle → public/editor.bundle.js (same as build.js).
await build({
  entryPoints: ["src/editor.js"],
  bundle: true,
  minify: true,
  format: "iife",
  outfile: "public/editor.bundle.js",
  logLevel: "info",
});

// 2. Server bundle → dist/server.js, fully self-contained.
await build({
  entryPoints: ["server.js"],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "bundle", // inline fastify/@fastify/static/chokidar, don't leave them as imports
  // fsevents is chokidar's optional native macOS accelerator; it can't be
  // bundled, and chokidar falls back to fs.watch without it.
  external: ["fsevents"],
  // esbuild's esm output has no `require`; recreate it for the rare dynamic require.
  banner: {
    js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
  },
  outfile: "dist/server.js",
  logLevel: "info",
});

// 3. Copy the static frontend (incl. the freshly built editor bundle).
await fs.cp(path.join(__dirname, "public"), path.join(dist, "public"), {
  recursive: true,
});

// 4. Reference config + a minimal package.json so `npm start` / `node server.js` work.
await fs.copyFile(
  path.join(__dirname, "config.example.json"),
  path.join(dist, "config.example.json"),
);

const pkg = {
  name: "nubsidian",
  private: true,
  type: "module", // server.js is ESM
  scripts: { start: "node server.js" },
  engines: { node: ">=18.11" },
};
await fs.writeFile(path.join(dist, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

await fs.writeFile(
  path.join(dist, "README.md"),
  `# Nubsidian (production build)

This is the auto-built \`production\` branch. Everything is bundled — there is
**no** \`npm install\` step and no \`node_modules\`.

## Run it

    cp config.example.json config.json   # then edit: set your port + roots
    node server.js                        # or: npm start

The server creates a default \`config.json\` for you if you skip the copy.

> Built from the \`main\` branch by \`build-production.js\`. Don't edit this
> branch by hand — changes here are overwritten on the next push to \`main\`.
`,
);

console.log("dist/ assembled — run: node dist/server.js");
