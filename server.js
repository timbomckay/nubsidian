import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import chokidar from "chokidar";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// config.json lists the document roots this app manages. Paths may use "~".
// {
//   "port": 4321,
//   "roots": [
//     { "name": "Project One Docs", "path": "~/OneDrive/project-one/docs" },
//     { "name": "Team Notes",       "path": "~/Documents/team-notes", "favorite": true }
//   ]
// }
// "favorite" is optional (omitted means false) and toggled from the UI.

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

const configPath = path.join(__dirname, "config.json");

// config.json is gitignored (it's local machine state, see config.example.json
// for the format) — create an empty one on first run so the app can still
// start; roots can then be added from the sidebar "+" or the dashboard.
async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const empty = { port: 4321, roots: [] };
    await fs.writeFile(configPath, JSON.stringify(empty, null, 2) + "\n", "utf8");
    console.log("No config.json found — created one with no roots configured.");
    return empty;
  }
}

const config = await readConfig();
const PORT = config.port ?? 4321;
const rawRoots = config.roots ?? []; // unexpanded, as written in config.json

// URL-friendly identifier for a root, e.g. "Team Notes" -> "team-notes",
// used as the first path segment of a document's URL. Uniqueness is
// enforced against the roots already assigned a slug (existingSlugs).
function slugify(name, existingSlugs) {
  const base =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "root";
  let slug = base;
  let n = 2;
  while (existingSlugs.has(slug)) slug = `${base}-${n++}`;
  existingSlugs.add(slug);
  return slug;
}

const rootSlugs = new Set();
const roots = rawRoots.map((r, i) => ({
  id: String(i),
  name: r.name ?? path.basename(r.path),
  path: path.resolve(expandHome(r.path)),
  favorite: !!r.favorite,
  slug: slugify(r.name ?? path.basename(r.path), rootSlugs),
}));
let nextRootId = roots.length; // monotonic, so ids stay unique after removals

// Persist the current roots (as typed, e.g. with "~") back to config.json.
async function writeConfig() {
  await fs.writeFile(
    configPath,
    JSON.stringify({ port: PORT, roots: rawRoots }, null, 2) + "\n",
    "utf8",
  );
}

const EDITABLE = new Set([".md", ".markdown"]);
const VIEWABLE = new Set([".html", ".htm"]);
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
const VISIBLE = new Set([...EDITABLE, ...VIEWABLE, ...IMAGE]);
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

// ---------------------------------------------------------------------------
// Path safety: every API call names a root id + a relative path. We resolve
// the pair and verify the result is still inside that root, so requests can
// never escape the configured directories.
// ---------------------------------------------------------------------------
function resolveSafe(rootId, relPath = "") {
  const root = roots.find((r) => r.id === rootId);
  if (!root) throw httpError(404, "Unknown root");
  const abs = path.resolve(root.path, relPath);
  if (abs !== root.path && !abs.startsWith(root.path + path.sep)) {
    throw httpError(400, "Path escapes root");
  }
  return { root, abs };
}

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

// Add a new root: validate it's a real directory (or create it if asked),
// persist it to config.json (keeping the path as typed, e.g. with "~"), and
// start watching it.
async function addRoot(name, rawPath, { create = false } = {}) {
  const resolved = path.resolve(expandHome(rawPath));
  const stat = await fs.stat(resolved).catch(() => null);

  if (!stat) {
    if (!create) throw httpError(404, `Directory does not exist: ${rawPath}`);
    await fs.mkdir(resolved, { recursive: true });
  } else if (!stat.isDirectory()) {
    throw httpError(400, `Not a directory: ${rawPath}`);
  }

  const root = {
    id: String(nextRootId++),
    name,
    path: resolved,
    favorite: false,
    slug: slugify(name, rootSlugs),
  };
  roots.push(root);
  rawRoots.push({ name, path: rawPath });
  await writeConfig();
  watchRoot(root);
  return root;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const app = Fastify({ logger: false });

app.register(fastifyStatic, {
  root: path.join(__dirname, "public"),
  prefix: "/",
});

// The configured roots (sidebar top level). Favorites first, otherwise
// config.json order (Array#sort is stable, so ties keep their order).
app.get("/api/roots", async () => ({
  roots: [...roots]
    .sort((a, b) => Number(b.favorite) - Number(a.favorite))
    .map(({ id, name, path: p, favorite, slug }) => ({ id, name, path: p, favorite, slug })),
}));

// One level of a directory tree (the UI lazy-loads on expand)
app.get("/api/tree", async (req) => {
  const { root: rootId, path: relPath = "" } = req.query;
  const { abs } = resolveSafe(rootId, relPath);
  const entries = await fs.readdir(abs, { withFileTypes: true });

  const items = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const rel = path.join(relPath, e.name);
    if (e.isDirectory()) {
      items.push({ type: "dir", name: e.name, path: rel });
    } else {
      const ext = path.extname(e.name).toLowerCase();
      if (!VISIBLE.has(ext)) continue;
      items.push({
        type: EDITABLE.has(ext) ? "markdown" : VIEWABLE.has(ext) ? "html" : "image",
        name: e.name,
        path: rel,
      });
    }
  }
  items.sort((a, b) =>
    (a.type === "dir") === (b.type === "dir")
      ? a.name.localeCompare(b.name)
      : a.type === "dir"
        ? -1
        : 1,
  );
  return { items };
});

// Flat recursive file listing for the quick switcher (⌘K). Directories are
// omitted — it's a jump-to-file palette, not a tree. Capped so a
// misconfigured root (e.g. someone's home directory) can't melt the browser.
app.get("/api/files", async (req) => {
  const { root: rootId } = req.query;
  const { abs } = resolveSafe(rootId, "");
  const files = [];
  const MAX_FILES = 5000;

  async function walk(dir, rel) {
    if (files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subdir — skip rather than fail the whole listing
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name), childRel);
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (!VISIBLE.has(ext)) continue;
        files.push({
          type: EDITABLE.has(ext) ? "markdown" : VIEWABLE.has(ext) ? "html" : "image",
          name: e.name,
          path: childRel,
        });
      }
    }
  }

  await walk(abs, "");
  return { files };
});

// Read a file. Images are binary, so this returns metadata only — the
// pixels come from /api/raw, loaded directly via an <img src>.
app.get("/api/file", async (req, reply) => {
  const { root: rootId, path: relPath } = req.query;
  const { abs } = resolveSafe(rootId, relPath);
  const ext = path.extname(abs).toLowerCase();
  if (!VISIBLE.has(ext)) throw httpError(400, "Unsupported file type");
  const stat = await fs.stat(abs);
  if (IMAGE.has(ext)) {
    reply.send({ kind: "image", mtimeMs: stat.mtimeMs });
    return;
  }
  const content = await fs.readFile(abs, "utf8");
  reply.send({
    content,
    kind: EDITABLE.has(ext) ? "markdown" : "html",
    mtimeMs: stat.mtimeMs,
  });
});

// Serve an image's raw bytes for <img src>.
app.get("/api/raw", async (req, reply) => {
  const { root: rootId, path: relPath } = req.query;
  const { abs } = resolveSafe(rootId, relPath);
  const ext = path.extname(abs).toLowerCase();
  if (!IMAGE.has(ext)) throw httpError(400, "Not an image");
  const buf = await fs.readFile(abs);
  reply.type(MIME[ext] ?? "application/octet-stream").send(buf);
});

// Save a markdown file
app.put("/api/file", async (req) => {
  const { root: rootId, path: relPath, content } = req.body;
  const { abs } = resolveSafe(rootId, relPath);
  if (!EDITABLE.has(path.extname(abs).toLowerCase())) {
    throw httpError(400, "Only markdown files are editable here");
  }
  await fs.writeFile(abs, content, "utf8");
  const stat = await fs.stat(abs);
  return { ok: true, mtimeMs: stat.mtimeMs };
});

// Create a file or folder
app.post("/api/create", async (req) => {
  const { root: rootId, path: relPath, kind } = req.body; // kind: "file" | "folder"
  const { abs } = resolveSafe(rootId, relPath);
  if (kind === "folder") {
    await fs.mkdir(abs, { recursive: true });
  } else {
    const ext = path.extname(abs).toLowerCase();
    if (!EDITABLE.has(ext)) throw httpError(400, "New files must be .md");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "", { flag: "wx" }); // fail if it already exists
  }
  return { ok: true };
});

// Rename (or move within the same root) a file or folder. Both ends go
// through resolveSafe, so neither side can escape the root.
app.post("/api/rename", async (req) => {
  const { root: rootId, from, to } = req.body;
  if (!from || !to) throw httpError(400, "from and to are required");
  const { abs: absFrom } = resolveSafe(rootId, from);
  const { abs: absTo } = resolveSafe(rootId, to);
  const stat = await fs.stat(absFrom);
  if (stat.isFile() && !VISIBLE.has(path.extname(absTo).toLowerCase())) {
    throw httpError(400, "New name must keep a supported extension");
  }
  if (await fs.stat(absTo).catch(() => null)) {
    throw httpError(409, "Something with that name already exists");
  }
  await fs.rename(absFrom, absTo);
  return { ok: true };
});

// Delete a file or folder (recursively). The root's top level itself can't be
// deleted this way — use DELETE /api/roots/:id to remove a root instead.
app.delete("/api/entry", async (req) => {
  const { root: rootId, path: relPath } = req.query;
  if (!relPath) throw httpError(400, "path is required");
  const { abs } = resolveSafe(rootId, relPath);
  await fs.rm(abs, { recursive: true });
  return { ok: true };
});

// Add a root directory, persisted to config.json. If the path doesn't exist,
// this 404s unless `create` is set, in which case it's created (mkdir -p).
app.post("/api/roots", async (req) => {
  const { name, path: rawPath, create } = req.body ?? {};
  if (!name || !rawPath) throw httpError(400, "name and path are required");
  const root = await addRoot(name, rawPath, { create: !!create });
  return { id: root.id, name: root.name, slug: root.slug };
});

// Toggle a root's favorite flag, persisted to config.json.
app.patch("/api/roots/:id", async (req) => {
  const { id } = req.params;
  const { favorite } = req.body ?? {};
  const idx = roots.findIndex((r) => r.id === id);
  if (idx === -1) throw httpError(404, "Unknown root");
  roots[idx].favorite = !!favorite;
  rawRoots[idx].favorite = !!favorite;
  await writeConfig();
  return { id, favorite: roots[idx].favorite };
});

// Remove a root (from config.json and the sidebar). Files on disk are untouched.
app.delete("/api/roots/:id", async (req) => {
  const { id } = req.params;
  const idx = roots.findIndex((r) => r.id === id);
  if (idx === -1) throw httpError(404, "Unknown root");
  const [removed] = roots.splice(idx, 1);
  rawRoots.splice(idx, 1);
  await writeConfig();
  unwatchRoot(removed);
  rootSlugs.delete(removed.slug);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Watcher → Server-Sent Events. When anything (you, a teammate via OneDrive
// sync, or Claude Code) touches a file on disk, connected browsers hear about
// it and refresh the tree / reload the open file.
// ---------------------------------------------------------------------------
const sseClients = new Set();

app.get("/api/events", (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  reply.raw.write("retry: 3000\n\n");
  sseClients.add(reply.raw);
  req.raw.on("close", () => sseClients.delete(reply.raw));
});

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) client.write(payload);
}

const watchers = new Map(); // root.id -> chokidar watcher

function watchRoot(root) {
  const watcher = chokidar.watch(root.path, {
    ignoreInitial: true,
    ignored: /(^|[\/\\])\../,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  watcher.on("all", (event, absPath) => {
    broadcast({
      event, // add | change | unlink | addDir | unlinkDir
      root: root.id,
      path: path.relative(root.path, absPath),
    });
  });
  watchers.set(root.id, watcher);
}

function unwatchRoot(root) {
  const watcher = watchers.get(root.id);
  if (!watcher) return;
  watcher.close();
  watchers.delete(root.id);
}

for (const root of roots) watchRoot(root);

// ---------------------------------------------------------------------------
// Document URLs look like /<root-slug>/<relative path>, e.g. /notes/todo.md
// (see slugify() above and the client's routing in app.js). There's no
// server-side route per document — the client reads location.pathname and
// fetches through /api/file — so any GET that isn't a known static asset or
// an /api/* call falls through here to the SPA shell, which does the actual
// routing once loaded. /api/* misses stay a real 404 instead.
app.setNotFoundHandler((req, reply) => {
  if (req.method !== "GET" || req.url.startsWith("/api/")) {
    reply.status(404).send({ error: "Not found" });
    return;
  }
  reply.sendFile("index.html");
});

app.setErrorHandler((err, req, reply) => {
  reply.status(err.statusCode ?? 500).send({ error: err.message });
});

await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`\n  Docs app running at http://localhost:${PORT}\n`);
for (const r of roots) console.log(`  • ${r.name}  →  ${r.path}`);
console.log("");
