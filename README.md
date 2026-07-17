# Nubsidian

A local, browser-based markdown editor and HTML viewer for document folders scattered across your machine — OneDrive-synced Teams folders, repo `docs/` directories, wherever. Think of it as a multi-root Obsidian you can run in a locked-down environment: no installers, no Homebrew, no database. Just Node and npm.

Editing is WYSIWYG (TipTap) — you work in the rendered document, not raw markdown with a side-by-side preview. HTML files render read-only in a sandboxed frame. A file watcher keeps the app in sync when files change on disk, so edits made by teammates (via OneDrive sync) or by Claude Code appear live.

## Requirements

- Node.js 18.11+ (no global installs, no admin rights needed)

## Setup

```bash
npm install
npm run build     # bundles the TipTap editor (one-time, and after dependency updates)
npm start         # http://localhost:4321
```

`npm run dev` does both in one step.

## Configuration

All state lives in `config.json` — no database. It's gitignored (it's local machine state, e.g. absolute paths on your disk); see [config.example.json](config.example.json) for the format. If it's missing, the server creates an empty one on startup (`{"port": 4321, "roots": []}`) so the app still comes up — add roots from the sidebar `+` or the dashboard, or edit the file directly.

Each entry under `roots` becomes a top-level section in the sidebar. `~` expands to your home directory, and Windows paths work too (`C:/Users/you/OneDrive/...`).

```json
{
  "port": 4321,
  "roots": [
    { "name": "Project One Docs", "path": "~/OneDrive/project-one/docs" },
    { "name": "Team Notes", "path": "~/Documents/team-notes" }
  ]
}
```

Restart the server after editing the config by hand (adding/removing/favoriting roots through the UI applies immediately, no restart needed).

## What it does

- **Sidebar file explorer** — each configured root is a labeled section; folders expand lazily; icons distinguish folders, markdown, HTML, and image files.
- **Markdown editing** — TipTap WYSIWYG with headings, lists, task lists, links, code blocks, blockquotes. Files autosave about a second after you stop typing; the header shows `saved` / `unsaved`.
- **HTML viewing** — `.html` files render in a sandboxed iframe (scripts disabled), read-only.
- **Image viewing** — `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, and `.ico` files show up in the tree and open read-only, scaled to fit the pane.
- **Create files and folders** — hover a folder (or a root) and click the `+`, or right-click it.
- **Delete files and folders** — hover a row and click the `×`, or right-click it and choose Delete; you're asked to confirm first.
- **Collapsible sidebar** — click a root's label to collapse/expand just that root (remembered across reloads), or use the `↕` in the sidebar header to collapse/expand everything at once.
- **Root management** — favorite (★), remove, or add roots from either the sidebar (hover a root label) or the dashboard shown when nothing's open. Removing a root only forgets it — files on disk are untouched.
- **Add root directories** — click the `+` in the sidebar header (or "+ Add root" on the dashboard), type a name and a path (supports `~`); it's validated, written to `config.json`, and watched immediately, no restart needed. If the path doesn't exist yet, you're offered to create it.
- **Live sync** — chokidar watches every root and pushes events to the browser over Server-Sent Events. External changes refresh the tree; if the file you have open changes on disk and you have no unsaved edits, it reloads in place; if it's deleted, the pane closes back to the dashboard.

All of the above use an in-app dialog for names/paths/confirmations rather than the browser's native `prompt`/`confirm`/`alert` — some browsers (installed PWAs especially) don't support those at all.

## Using with Claude Code

The app deliberately knows nothing about Claude. Claude Code just works against the same directories on disk:

```
Review the docs in ~/OneDrive/project-one/docs and update
onboarding.md to reflect the new deployment process.
```

Because of the watcher, any file Claude Code edits shows up in Nubsidian immediately. Two tips:

- Add a short `CLAUDE.md` in each doc root describing its purpose and conventions, so Claude Code has context whenever you point it there.
- The server binds to `127.0.0.1` only — nothing is exposed on your network.

## Architecture

```
config.json          directory roots + port (the only state)
server.js            Fastify: static hosting, file APIs, chokidar → SSE
src/editor.js        TipTap setup, bundled by esbuild
build.js             esbuild bundler (outputs public/editor.bundle.js)
public/
  index.html         shell
  app.js             vanilla JS: tree, editor lifecycle, autosave, SSE
  styles.css         no framework
```

API surface (all constrained to the configured roots — paths are resolved and verified server-side so requests can't escape them):

| Method | Route          | Purpose                                  |
| ------ | -------------- | ---------------------------------------- |
| GET    | `/api/roots`     | configured roots, favorites first        |
| GET    | `/api/tree`      | one directory level (lazy-loaded)        |
| GET    | `/api/file`      | read a markdown or HTML file             |
| PUT    | `/api/file`      | save a markdown file                     |
| GET    | `/api/raw`       | raw bytes of an image (for `<img>`)       |
| POST   | `/api/create`    | create a `.md` file or a folder          |
| DELETE | `/api/entry`     | delete a file or folder, recursively     |
| POST   | `/api/roots`     | add a root directory, persisted to config.json |
| PATCH  | `/api/roots/:id` | toggle a root's favorite flag            |
| DELETE | `/api/roots/:id` | remove a root (files on disk untouched)  |
| GET    | `/api/events`    | SSE stream of file-system change events  |

## Extending

Some natural next steps, in rough order of payoff: full-text search across roots (a small index rebuilt from the watcher), rename/move from the context menu, a table extension for TipTap, and frontmatter display.
