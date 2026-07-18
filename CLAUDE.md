# Nubsidian

A local, browser-based markdown editor and HTML viewer for document folders scattered across the filesystem (OneDrive-synced Teams folders, repo `docs/` directories, etc.) — a multi-root Obsidian-style app that runs with no installers, no database, and no build step beyond bundling the editor.

## Architecture

```
config.json          directory roots + port — the only state the app has (gitignored)
config.example.json   reference format for config.json, committed
server.js             Fastify: static hosting, file APIs, chokidar → SSE
src/editor.js         TipTap setup (source), bundled by esbuild
build.js               esbuild bundler → public/editor.bundle.js
public/
  index.html           shell
  app.js               vanilla JS: tree, editor lifecycle, autosave, SSE client
  styles.css           no framework
  editor.bundle.js     generated — do not edit directly, edit src/editor.js and rebuild
```

- **No database.** All state is `config.json` (port + named `roots`, each an absolute or `~`-relative path). Restart the server after editing it by hand. It's gitignored — machine-local state, not project config — with `config.example.json` committed as the reference format. If `config.json` is missing, `server.js` creates an empty one (`{"port": 4321, "roots": []}`) on startup rather than failing, since roots can now be added entirely from the UI.
- **No React, no frontend framework.** `public/app.js` is plain DOM manipulation — element refs via `getElementById`, manual event listeners, manual tree rendering. Keep new frontend work in this style rather than introducing a framework or build step for `app.js` itself.
- The *only* thing that goes through esbuild is `src/editor.js` (the TipTap integration), because TipTap ships as ES modules that need bundling into a single `<script>`-able file. `public/app.js` is loaded directly, unbundled.
- Editing is WYSIWYG (TipTap), not raw markdown with a preview pane — `tiptap-markdown` converts between the ProseMirror doc and markdown text on load/save.
- `.html` files are read-only, rendered in a sandboxed `<iframe>` (`sandbox="allow-same-origin"`, no `allow-scripts`) — scripts never execute.
- Images (`.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.svg`/`.bmp`/`.ico`) are read-only too, shown via a plain `<img>` pointing at `GET /api/raw` — the one route that returns raw bytes with a real `Content-Type` instead of JSON, since `/api/file` reads text as UTF-8 and would corrupt binary image data.
- A chokidar watcher per root pushes filesystem changes to the browser over Server-Sent Events (`/api/events`), so external edits (teammates via OneDrive sync, Claude Code, etc.) show up live without a page reload.
- When no document is open, the pane shows a **root-management dashboard** (`#empty` in index.html) instead of a static placeholder — one card per root with favorite/remove actions, plus an "Add root" card. The sidebar has the same actions (hover a root or folder row) so either surface can be used interchangeably; both re-render from a single `refreshRootUI()` call so they never drift out of sync.
- Deleting the file or folder that's currently open (locally, or by another process — picked up via the SSE watcher) resets the pane back to that dashboard rather than showing a stale editor.
- **The open document is the URL** — `/<root-slug>/<relative path>` (e.g. `/notes/todo.md`), pushed via `history.pushState` in `syncUrl()`/read back via `routeFromUrl()` in `public/app.js`. A bare `/` is home (the dashboard); clicking the sidebar wordmark button goes there. Since there's no server-side route per document, `server.js`'s `setNotFoundHandler` serves `index.html` for any non-`/api/*` GET that isn't a static asset, so refreshing or sharing a document URL works — the client does the actual routing once loaded. Root slugs are derived from each root's name (`slugify()` in `server.js`, deduped on collision) and returned as `slug` on every root object.
- **No right-click context menus** — every row (root, folder, file) has a "⋮" action button (`makeActionBtn()`) that opens a dropdown (`showActionMenu()`) with the actions valid for that item (new file/folder, rename, delete, favorite/remove for roots). Add new per-item actions there rather than a `contextmenu` handler.
- **No native `prompt()`/`confirm()`/`alert()`.** Some browsers (installed PWAs in particular) don't support them at all. All user input and confirmations go through the custom modal in `public/app.js` (`showPrompt()`/`showConfirm()`/`showAlert()`, backed by `#modalOverlay` in index.html) — use these for any new feature that needs to ask the user something, never the native dialogs.

## API routes

All routes take a `root` id (string index into `config.json`'s `roots` array, assigned at server startup) and resolve paths server-side via `resolveSafe()` in [server.js](server.js), which verifies the resolved absolute path is still inside that root's directory — requests can't escape the configured roots.

| Method | Route              | Purpose                                                    |
| ------ | ------------------ | ----------------------------------------------------------- |
| GET    | `/api/roots`       | List configured roots (`{id, name, path, favorite, slug}`), favorites first |
| GET    | `/api/tree`        | One directory level, lazy-loaded (`?root=&path=`)            |
| GET    | `/api/files`       | Flat recursive file listing for the ⌘K quick switcher (`?root=`), capped at 5000 entries |
| GET    | `/api/file`        | Read a markdown or HTML file (`?root=&path=`)                |
| PUT    | `/api/file`        | Save a markdown file (body: `{root, path, content}`)         |
| GET    | `/api/raw`         | Raw bytes of an image, with its real Content-Type (`?root=&path=`) |
| POST   | `/api/create`      | Create a `.md` file or a folder (body: `{root, path, kind}`) |
| POST   | `/api/rename`      | Rename/move a file or folder within a root (body: `{root, from, to}`) |
| DELETE | `/api/entry`       | Delete a file or folder, recursively (`?root=&path=`)        |
| POST   | `/api/roots`       | Add a root directory (body: `{name, path, create}`), persisted to `config.json` |
| PATCH  | `/api/roots/:id`   | Toggle a root's favorite flag (body: `{favorite}`), persisted |
| DELETE | `/api/roots/:id`   | Remove a root (config + watcher only — files untouched)      |
| GET    | `/api/events`      | SSE stream of filesystem change events                      |

Only `.md`/`.markdown` are editable (`EDITABLE`); `.html`/`.htm` (`VIEWABLE`) and images (`IMAGE`) are read-only. All three sets are visible in the tree; everything else is filtered out, along with dotfiles. `GET /api/file` returns metadata only for images (`{kind: "image", mtimeMs}`, no `content`) — the client fetches the actual bytes separately from `/api/raw`.

`/api/roots` (POST) is the one route that doesn't take a `root` id — it defines a new one, so it validates the given path is a real directory (`fs.stat`) rather than going through `resolveSafe()`, then appends it to both the in-memory `roots` array and `config.json` on disk and starts a watcher for it. If the path doesn't exist yet, it 404s unless `create: true` is passed, in which case it's created (`mkdir -p`) — the client uses this to ask "doesn't exist, create it?" before retrying.

`DELETE /api/entry` requires a non-empty `path` — it can't be used to wipe out a root's top level (that's what `DELETE /api/roots/:id` is for, and that one never touches disk).

## Conventions

- **Config-driven roots** — never hardcode a filesystem path; add it to `config.json` under `roots`. Each root also has an optional `favorite` boolean (omitted when false). Root ids are assigned from a monotonic counter (`nextRootId` in [server.js](server.js)), not array position — they stay unique even after roots are removed, so don't switch id assignment back to `roots.length`.
- **No database** — don't add one. Persistent state beyond file contents belongs in `config.json` if it's app-level config, or in the files themselves. The one exception is client-only UI state in `localStorage` (`nubsidian.collapsedRoots` for sidebar collapse, `nubsidian.recentFiles` for the recents list) since those are UI preferences, not app config. Session restore isn't `localStorage`-based — it's the URL (see above).
- **No frontend framework** — `public/app.js` stays vanilla JS/DOM. Don't introduce React, Vue, htmx, etc. for the shell UI.
- **Server-side path safety is mandatory** — any new route that takes a path must go through `resolveSafe()` (or equivalent) rather than trusting client-supplied paths directly.
- **`[hidden]` vs. explicit `display`** — several elements are shown/hidden via the `.hidden` DOM property (`editorWrap`, `htmlView`, `imgView`, `modalOverlay`, `modalInput`). If a CSS rule sets `display` unconditionally on that element's class (e.g. `.img-view { display: flex }`), it overrides the browser's built-in `[hidden] { display: none }` and the element stays visible even when "hidden" — happened twice already (`.img-view`, `.modal-input`). Always scope the `display` override to `:not([hidden])`.
- **This repo is public on GitHub** (`timbomckay/nubsidian`) — never commit anything with real local machine paths or other personal info; that's why `config.json` is gitignored in favor of `config.example.json`.
- **Watchers are tracked per root** (`watchers` Map in server.js, keyed by root id) so removing a root can `.close()` its chokidar watcher instead of leaking it.
- After changing `src/editor.js`, run `npm run build` (or `npm run dev`, which builds then starts) — edits to it have no effect until the bundle regenerates.
- After changing `config.json`, restart the server (no hot-reload for config) — though adding/removing/favoriting roots through the UI does *not* require a restart, since those routes mutate the in-memory state and watchers directly.
- `config.json` is gitignored (machine-local paths); keep `config.example.json` in sync with the schema if it changes, since it's the only version tracked in git.
