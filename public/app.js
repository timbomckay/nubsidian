/* Nubsidian frontend — vanilla JS, no framework.
   Talks to the Fastify API, hosts the TipTap bundle for markdown editing,
   renders HTML files in a sandboxed iframe, and listens to the server's
   file watcher over SSE so external edits (teammates, Claude Code) show up. */

const $ = (id) => document.getElementById(id);
const treeEl = $("tree");
const editorWrap = $("editorWrap");
const htmlView = $("htmlView");
const imgView = $("imgView");
const imgViewImg = $("imgViewImg");
const emptyEl = $("empty");
const rootGridEl = $("rootGrid");
const paneHead = $("paneHead");
const crumbEl = $("crumb");
const saveStateEl = $("saveState");
const actionMenu = $("actionMenu");
const modalOverlay = $("modalOverlay");
const modalMessage = $("modalMessage");
const modalInput = $("modalInput");
const modalCancel = $("modalCancel");
const modalOk = $("modalOk");
const tocPanel = $("tocPanel");
const wordCountEl = $("wordCount");
const dashboardHintEl = $("dashboardHint");
const recentListEl = $("recentList");
const paletteOverlay = $("paletteOverlay");
const paletteInput = $("paletteInput");
const paletteList = $("paletteList");

// "⌘K" on a Mac, "Ctrl+K" elsewhere — used in the hint text and shortcuts.
const IS_MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform);
const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl+";

const ICONS = {
  dir: `<svg class="icon" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3l1.5 2H13A1.5 1.5 0 0 1 14.5 5v7A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V3z"/></svg>`,
  markdown: `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="3.5" width="13" height="9" rx="1.2"/><path d="M3.8 10.2V5.8l2 2.4 2-2.4v4.4M11 5.8v4.4m0 0-1.6-1.7M11 10.2l1.6-1.7"/></svg>`,
  html: `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3M9 3.5 7 12.5"/></svg>`,
  image: `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><circle cx="5.2" cy="6.2" r="1.2" fill="currentColor" stroke="none"/><path d="m2.2 11.5 3.6-3.6 2.4 2.4 2-2 3.6 3.6"/></svg>`,
};

let current = null; // { root, path, kind, mtimeMs }
let editor = null;
let dirty = false;
let saveTimer = null;

// ---------------------------------------------------------------- API helpers
async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

const listRoots = () => api("/api/roots");
const listDir = (root, p = "") => api(`/api/tree?root=${root}&path=${encodeURIComponent(p)}`);
const readFile = (root, p) => api(`/api/file?root=${root}&path=${encodeURIComponent(p)}`);
const saveFile = (root, p, content) =>
  api("/api/file", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root, path: p, content }),
  });
const createEntry = (root, p, kind) =>
  api("/api/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root, path: p, kind }),
  });
const deleteEntry = (root, p) =>
  api(`/api/entry?root=${root}&path=${encodeURIComponent(p)}`, { method: "DELETE" });
const listFiles = (root) => api(`/api/files?root=${root}`);
const renameEntry = (root, from, to) =>
  api("/api/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root, from, to }),
  });
const addRoot = (name, p, create = false) =>
  api("/api/roots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, path: p, create }),
  });
const removeRoot = (id) => api(`/api/roots/${id}`, { method: "DELETE" });
const setFavorite = (id, favorite) =>
  api(`/api/roots/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorite }),
  });

// ------------------------------------------------------------------- modal
// Some browsers (notably installed PWAs) don't support window.prompt/confirm/
// alert at all, so the app can't rely on them — this is a self-contained
// replacement backed by the #modalOverlay markup.
function showModal({
  message,
  showInput = false,
  defaultValue = "",
  okLabel = "OK",
  cancelLabel = "Cancel",
  showCancel = true,
  danger = false,
}) {
  return new Promise((resolve) => {
    modalMessage.textContent = message;
    modalInput.hidden = !showInput;
    modalInput.value = defaultValue;
    modalCancel.hidden = !showCancel;
    modalCancel.textContent = cancelLabel;
    modalOk.textContent = okLabel;
    modalOk.classList.toggle("danger", danger);
    modalOverlay.hidden = false;
    (showInput ? modalInput : modalOk).focus();
    if (showInput) modalInput.select();

    const cleanup = (result) => {
      modalOverlay.hidden = true;
      modalOk.removeEventListener("click", onOk);
      modalCancel.removeEventListener("click", onCancel);
      modalOverlay.removeEventListener("keydown", onKeydown);
      modalOverlay.removeEventListener("click", onBackdrop);
      resolve(result);
    };
    const onOk = () => cleanup(showInput ? modalInput.value.trim() || null : true);
    const onCancel = () => cleanup(showInput ? null : false);
    const onKeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onOk();
      } else if (e.key === "Escape") {
        e.preventDefault();
        showCancel ? onCancel() : onOk();
      }
    };
    const onBackdrop = (e) => {
      if (e.target === modalOverlay) (showCancel ? onCancel : onOk)();
    };

    modalOk.addEventListener("click", onOk);
    modalCancel.addEventListener("click", onCancel);
    modalOverlay.addEventListener("keydown", onKeydown);
    modalOverlay.addEventListener("click", onBackdrop);
  });
}

const showPrompt = (message, defaultValue = "") =>
  showModal({ message, showInput: true, defaultValue });
const showConfirm = (message, { okLabel = "Delete", danger = true } = {}) =>
  showModal({ message, okLabel, danger });
const showAlert = (message) => showModal({ message, showCancel: false });

// The TipTap bundle's bubble-menu link button needs the modal (no native
// prompt() allowed), but it lives in a separate bundle loaded before this
// script defines showPrompt — fine, since it's only called later on click.
window.showPrompt = showPrompt;

// ------------------------------------------------------------------- toc
// H1 is redundant with the doc title and h4+ is too granular for a nav —
// matches the "on this page" convention most docs sites (Docusaurus,
// Mintlify) use: h2/h3 only.
function renderToc(items) {
  const headings = items.filter(
    (item) => item.textContent.trim() && item.originalLevel >= 2 && item.originalLevel <= 3,
  );
  tocPanel.hidden = headings.length < 2;
  tocPanel.innerHTML = "";
  for (const item of headings) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "toc-item" + (item.isActive ? " is-active" : "");
    link.style.setProperty("--toc-level", item.originalLevel - 1);
    link.textContent = item.textContent;
    link.addEventListener("click", () => editor?.scrollToHeading(item.id));
    tocPanel.appendChild(link);
  }
}

// ------------------------------------------------------------------ recents
// Client-only UI state, like the sidebar collapse set: which files were
// opened recently (dashboard + quick-switcher). Entries are {root, path, kind}.
const RECENT_KEY = "nubsidian.recentFiles";
let recents = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");

function recordRecent(root, relPath, kind) {
  recents = [
    { root, path: relPath, kind },
    ...recents.filter((r) => !(r.root === root && r.path === relPath)),
  ].slice(0, 20);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
}

// Drop an entry that turned out to be stale (file deleted/renamed on disk).
function forgetRecent(root, relPath) {
  recents = recents.filter((r) => !(r.root === root && r.path === relPath));
  localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
}

// ---------------------------------------------------------------------- url
// The open document is reflected as /<root-slug>/<relative path> so a
// refresh (or a shared link) lands back on the same file, and back/forward
// navigate history. The slug<->root id mapping comes from rootsCache.
function pathFor(rootId, relPath) {
  const root = rootsCache.find((r) => r.id === rootId);
  if (!root) return null;
  return "/" + [root.slug, ...relPath.split("/")].map(encodeURIComponent).join("/");
}

function syncUrl(rootId, relPath) {
  const next = rootId != null && relPath ? pathFor(rootId, relPath) : "/";
  if (next && next !== location.pathname) {
    history.pushState({ root: rootId, path: relPath }, "", next);
  }
}

function routeFromUrl() {
  const segments = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length < 2) return null;
  const [slug, ...rest] = segments;
  const root = rootsCache.find((r) => r.slug === slug);
  return root ? { root: root.id, path: rest.join("/") } : null;
}

window.addEventListener("popstate", (e) => {
  const route = e.state?.path ? e.state : routeFromUrl();
  if (route?.root != null && route?.path) {
    openFileSafe(route.root, route.path, { silent: true });
  } else {
    closeCurrent({ clearUrl: false });
  }
});

// ------------------------------------------------------------ root collapse
const COLLAPSE_KEY = "nubsidian.collapsedRoots";
const collapsedRoots = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]"));

function persistCollapsed() {
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsedRoots]));
}

function toggleRootCollapse(label, name) {
  const collapsed = label.classList.toggle("collapsed");
  if (collapsed) collapsedRoots.add(name);
  else collapsedRoots.delete(name);
  persistCollapsed();
}

// -------------------------------------------------------------------- tree
function makeActionBtn(rootId, item, { starred = false } = {}) {
  const btn = document.createElement("button");
  btn.className = "action-btn" + (starred ? " starred" : "");
  btn.type = "button";
  btn.title = "Actions…";
  btn.textContent = starred ? "★" : "⋮";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    showActionMenu(btn, rootId, item);
  });
  return btn;
}

// Shared by the sidebar root-label and the dashboard root-card.
function makeStarBtn(root) {
  const btn = document.createElement("button");
  btn.className = "star-btn" + (root.favorite ? " active" : "");
  btn.type = "button";
  btn.title = root.favorite ? "Unfavorite" : "Favorite";
  btn.textContent = "★";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await setFavorite(root.id, !root.favorite);
      refreshRootUI();
    } catch (err) {
      showAlert(err.message);
    }
  });
  return btn;
}

function makeRemoveRootBtn(root) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = await showConfirm(
      `Remove "${root.name}" from the sidebar? Files on disk are not touched.`,
      { okLabel: "Remove" },
    );
    if (!ok) return;
    try {
      await removeRoot(root.id);
      refreshRootUI();
    } catch (err) {
      showAlert(err.message);
    }
  });
  return btn;
}

// Fetches the current roots once and re-renders both the sidebar and the
// dashboard from it, so favorite/add/remove stay in sync wherever they happen.
// The roots are kept around for the quick switcher and recents (badges need
// root names without refetching).
let rootsCache = [];

async function refreshRootUI() {
  const { roots } = await listRoots();
  rootsCache = roots;
  renderDashboard(roots);
  await renderTree(roots);
}

// Resolves once every root's top level is rendered, so callers (session
// restore, the quick switcher) can expand into the tree right after.
function renderTree(roots) {
  treeEl.innerHTML = "";
  const pending = [];
  for (const root of roots) {
    const label = document.createElement("div");
    label.className = "root-label" + (collapsedRoots.has(root.name) ? " collapsed" : "");

    const text = document.createElement("span");
    text.className = "label";
    text.textContent = root.name;
    label.appendChild(text);

    label.appendChild(
      makeActionBtn(root.id, { type: "dir", path: "" }, { starred: root.favorite }),
    );

    label.addEventListener("click", () => toggleRootCollapse(label, root.name));
    treeEl.appendChild(label);

    const section = document.createElement("div");
    section.className = "root-section";
    section.dataset.root = root.id;
    treeEl.appendChild(section);

    pending.push(renderChildren(section, root.id, ""));
  }
  return Promise.all(pending);
}

// Highlight the row for the currently open file, if it's visible. Called
// after every (re-)render so the highlight survives SSE-driven refreshes.
function markActiveRow() {
  treeEl.querySelectorAll(".row.active").forEach((r) => r.classList.remove("active"));
  if (!current) return;
  treeEl
    .querySelector(`.node[data-root="${current.root}"][data-path="${CSS.escape(current.path)}"]`)
    ?.querySelector(":scope > .row")
    ?.classList.add("active");
}

// Expand the tree down to a file (uncollapsing its root if needed) and
// scroll its row into view — used when a file is opened from somewhere other
// than the tree itself (quick switcher, recents, session restore).
async function revealInTree(rootId, relPath) {
  const section = treeEl.querySelector(`.root-section[data-root="${rootId}"]`);
  const label = section?.previousElementSibling;
  if (label?.classList.contains("collapsed")) {
    label.classList.remove("collapsed");
    collapsedRoots.delete(label.querySelector(".label").textContent);
    persistCollapsed();
  }

  const parts = relPath.split("/").slice(0, -1);
  let dir = "";
  for (const part of parts) {
    dir = dir ? `${dir}/${part}` : part;
    const node = treeEl.querySelector(
      `.node[data-root="${rootId}"][data-path="${CSS.escape(dir)}"]`,
    );
    if (!node) return;
    node.classList.add("open");
    const children = node.querySelector(":scope > .children");
    if (children && !children.dataset.loaded) {
      children.dataset.loaded = "1";
      await renderChildren(children, rootId, dir);
    }
  }

  markActiveRow();
  treeEl
    .querySelector(`.node[data-root="${rootId}"][data-path="${CSS.escape(relPath)}"]`)
    ?.scrollIntoView({ block: "nearest" });
}

async function renderChildren(container, rootId, dirPath) {
  let items;
  try {
    ({ items } = await listDir(rootId, dirPath));
  } catch (err) {
    container.innerHTML = `<div class="row" style="opacity:.5">unavailable — ${err.message}</div>`;
    return;
  }
  container.innerHTML = "";
  for (const item of items) container.appendChild(makeNode(rootId, item));
  markActiveRow();
}

function makeNode(rootId, item) {
  const node = document.createElement("div");
  node.className = "node";
  node.dataset.root = rootId;
  node.dataset.path = item.path;
  node.dataset.type = item.type;

  const row = document.createElement("div");
  row.className = "row";
  node.appendChild(row);

  if (item.type === "dir") {
    row.tabIndex = 0;
    row.innerHTML = ICONS.dir + `<span class="label">${item.name}</span>`;
    row.appendChild(makeActionBtn(rootId, item));

    const children = document.createElement("div");
    children.className = "children";
    node.appendChild(children);
    row.addEventListener("click", () => {
      const opening = !node.classList.contains("open");
      node.classList.toggle("open", opening);
      if (opening && !children.dataset.loaded) {
        children.dataset.loaded = "1";
        renderChildren(children, rootId, item.path);
      }
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        row.click();
      }
    });
  } else {
    // A real link, not just a click handler, so cmd/ctrl/middle-click and
    // "open in new tab" from the browser's own context menu work — a plain
    // click still stays in-app (no full page reload) via preventDefault.
    const link = document.createElement("a");
    link.className = "row-link";
    link.href = pathFor(rootId, item.path) ?? "#";
    link.innerHTML = ICONS[item.type] + `<span class="label">${item.name}</span>`;
    link.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openFile(rootId, item.path).catch((err) => showAlert(err.message));
    });
    row.appendChild(link);
    row.appendChild(makeActionBtn(rootId, item));
  }
  return node;
}

// ---------------------------------------------------------------- dashboard
function renderRecents(roots) {
  recentListEl.innerHTML = "";
  const valid = recents
    .map((r) => {
      const root = roots.find((x) => x.id === r.root);
      return root && { ...r, rootName: root.name };
    })
    .filter(Boolean)
    .slice(0, 6);
  recentListEl.hidden = !valid.length;
  if (!valid.length) return;

  const title = document.createElement("div");
  title.className = "recent-title";
  title.textContent = "Recent";
  recentListEl.appendChild(title);

  for (const r of valid) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "recent-item";
    btn.innerHTML = ICONS[r.kind] ?? ICONS.markdown;
    const name = document.createElement("span");
    name.className = "r-name";
    name.textContent = r.path.split("/").pop();
    const pathEl = document.createElement("span");
    pathEl.className = "r-path";
    pathEl.textContent = r.path;
    const badge = document.createElement("span");
    badge.className = "r-root";
    badge.textContent = r.rootName;
    btn.append(name, pathEl, badge);
    btn.addEventListener("click", () => openFileSafe(r.root, r.path));
    recentListEl.appendChild(btn);
  }
}

function renderDashboard(roots) {
  dashboardHintEl.innerHTML = `Select a document from the sidebar, press <kbd>${MOD_LABEL}K</kbd> to jump to any file, or manage your roots below.`;
  renderRecents(roots);
  rootGridEl.innerHTML = "";
  for (const root of roots) {
    const card = document.createElement("div");
    card.className = "root-card";

    const head = document.createElement("div");
    head.className = "root-card-head";
    const name = document.createElement("span");
    name.className = "root-card-name";
    name.textContent = root.name;
    head.appendChild(name);
    head.appendChild(makeStarBtn(root));
    card.appendChild(head);

    const pathEl = document.createElement("div");
    pathEl.className = "root-card-path";
    pathEl.textContent = root.path;
    card.appendChild(pathEl);

    const actions = document.createElement("div");
    actions.className = "root-card-actions";
    const removeBtn = makeRemoveRootBtn(root);
    removeBtn.className = "root-card-remove";
    removeBtn.textContent = "Remove";
    actions.appendChild(removeBtn);
    card.appendChild(actions);

    rootGridEl.appendChild(card);
  }

  const addCard = document.createElement("button");
  addCard.className = "root-card add-root-card";
  addCard.type = "button";
  addCard.textContent = "+ Add root";
  addCard.addEventListener("click", addRootFlow);
  rootGridEl.appendChild(addCard);
}

// ------------------------------------------------------------------- opening
async function openFile(rootId, relPath) {
  if (!(await flushSave())) {
    const discard = await showConfirm(
      "Your latest edits couldn't be saved. Discard them and continue?",
      { okLabel: "Discard" },
    );
    if (!discard) return;
    dirty = false;
  }
  const { content, kind, mtimeMs } = await readFile(rootId, relPath);
  current = { root: rootId, path: relPath, kind, mtimeMs };
  recordRecent(rootId, relPath, kind);
  syncUrl(rootId, relPath);
  markActiveRow();

  paneHead.hidden = false;
  crumbEl.textContent = relPath;
  emptyEl.hidden = true;

  editorWrap.hidden = true;
  htmlView.hidden = true;
  imgView.hidden = true;
  tocPanel.hidden = true;

  if (kind === "markdown") {
    editorWrap.hidden = false;
    if (editor) editor.destroy();
    $("editor").innerHTML = "";
    editor = window.createMarkdownEditor({
      element: $("editor"),
      markdown: content,
      onUpdate: scheduleSave,
      onTocUpdate: renderToc,
    });
    setSaveState("saved");
    updateWordCount(content);
    editor.focus();
  } else if (kind === "image") {
    imgView.hidden = false;
    imgViewImg.src = `/api/raw?root=${rootId}&path=${encodeURIComponent(relPath)}&t=${mtimeMs}`;
    setSaveState("read-only");
    updateWordCount(null);
  } else {
    htmlView.hidden = false;
    htmlView.srcdoc = content; // sandboxed: scripts do not run
    setSaveState("read-only");
    updateWordCount(null);
  }
}

// Open + reveal in the tree, for entry points outside the tree (quick
// switcher, recents, session restore). A failed open usually means the file
// is gone, so the stale recents entry is dropped instead of erroring again.
async function openFileSafe(rootId, relPath, { silent = false } = {}) {
  try {
    await openFile(rootId, relPath);
    await revealInTree(rootId, relPath);
  } catch (err) {
    forgetRecent(rootId, relPath);
    renderDashboard(rootsCache);
    if (!silent) showAlert(`Couldn't open "${relPath}": ${err.message}`);
  }
}

function closeCurrent({ clearUrl = true } = {}) {
  current = null;
  if (editor) {
    editor.destroy();
    editor = null;
  }
  editorWrap.hidden = true;
  htmlView.hidden = true;
  imgView.hidden = true;
  tocPanel.hidden = true;
  paneHead.hidden = true;
  emptyEl.hidden = false;
  markActiveRow();
  if (clearUrl) syncUrl(null, null);
}

// ------------------------------------------------------------------ saving
function setSaveState(text) {
  saveStateEl.textContent = text;
  saveStateEl.classList.toggle("dirty", text === "unsaved");
  saveStateEl.classList.toggle("error", text.startsWith("save failed"));
}

function updateWordCount(md) {
  wordCountEl.textContent =
    typeof md === "string"
      ? `${(md.trim().match(/\S+/g) || []).length.toLocaleString()} words`
      : "";
}

// The editor's onUpdate hands us the fresh markdown, so the word count can
// ride along with the save debounce for free.
function scheduleSave(md) {
  dirty = true;
  setSaveState("unsaved");
  if (typeof md === "string") updateWordCount(md);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 800);
}

// Returns whether the document is safely on disk. A failed save keeps the
// content dirty and shows an error in the pane header instead of silently
// pretending everything is fine — ⌘S (or more typing) retries.
async function flushSave() {
  if (!dirty || !current || current.kind !== "markdown" || !editor) return true;
  clearTimeout(saveTimer);
  try {
    const { mtimeMs } = await saveFile(current.root, current.path, editor.getMarkdown());
    current.mtimeMs = mtimeMs;
    dirty = false;
    setSaveState("saved");
    return true;
  } catch (err) {
    setSaveState(`save failed — ${MOD_LABEL}S to retry`);
    return false;
  }
}

window.addEventListener("beforeunload", () => {
  if (dirty) flushSave();
});

// ------------------------------------------------------- live updates (SSE)
const events = new EventSource("/api/events");
events.onopen = () => ($("status").hidden = true);
events.onerror = () => ($("status").hidden = false);
events.onmessage = async (msg) => {
  const { event, root, path } = JSON.parse(msg.data);

  // Refresh the part of the tree that changed
  if (event === "add" || event === "unlink" || event === "addDir" || event === "unlinkDir") {
    refreshDirOf(root, path);
  }

  // If the open file (or a folder containing it) was deleted, close the pane
  if (
    (event === "unlink" || event === "unlinkDir") &&
    current &&
    current.root === root &&
    (current.path === path || current.path.startsWith(`${path}/`))
  ) {
    closeCurrent();
  }

  // Deleted files shouldn't linger in the recents list
  if (event === "unlink" || event === "unlinkDir") {
    const gone = (r) => r.root === root && (r.path === path || r.path.startsWith(`${path}/`));
    if (recents.some(gone)) {
      recents = recents.filter((r) => !gone(r));
      localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
      renderRecents(rootsCache);
    }
  }

  // If the open file changed on disk and we have no unsaved edits, reload it
  if (event === "change" && current && current.root === root && current.path === path && !dirty) {
    const { content, mtimeMs } = await readFile(root, path);
    if (mtimeMs !== current.mtimeMs) {
      current.mtimeMs = mtimeMs;
      if (current.kind === "markdown" && editor) editor.setMarkdown(content);
      else if (current.kind === "html") htmlView.srcdoc = content;
      else if (current.kind === "image") {
        imgViewImg.src = `/api/raw?root=${root}&path=${encodeURIComponent(path)}&t=${mtimeMs}`;
      }
    }
  }
};

function refreshDirOf(rootId, relPath) {
  const parent = relPath.split(/[\\/]/).slice(0, -1).join("/");
  if (parent === "") {
    const section = treeEl.querySelector(`.root-section[data-root="${rootId}"]`);
    if (section) renderChildren(section, rootId, "");
    return;
  }
  const dirNode = treeEl.querySelector(
    `.node[data-root="${rootId}"][data-path="${CSS.escape(parent)}"]`,
  );
  const children = dirNode?.querySelector(".children");
  if (children?.dataset.loaded) renderChildren(children, rootId, parent);
}

// ------------------------------------------------------------- action menu
// Every row's "⋮" button opens the same dropdown: new file/folder for
// directories, rename/delete for anything with a path.
function showActionMenu(anchorBtn, rootId, item) {
  actionMenu.innerHTML = "";
  const isRoot = item.type === "dir" && !item.path;
  if (item.type === "dir") {
    const join = (name) => (item.path ? `${item.path}/${name}` : name);
    addAction("New markdown file…", async () => {
      const name = await showPrompt("File name (e.g. notes.md):");
      if (!name) return;
      const file = name.endsWith(".md") ? name : `${name}.md`;
      await createEntry(rootId, join(file), "file");
    });
    addAction("New folder…", async () => {
      const name = await showPrompt("Folder name:");
      if (!name) return;
      await createEntry(rootId, join(name), "folder");
    });
  }
  if (isRoot) {
    const root = rootsCache.find((r) => r.id === rootId);
    if (root) {
      addAction(root.favorite ? "Unfavorite" : "Favorite", async () => {
        await setFavorite(root.id, !root.favorite);
        refreshRootUI();
      });
      addAction("Remove root…", async () => {
        const ok = await showConfirm(
          `Remove "${root.name}" from the sidebar? Files on disk are not touched.`,
          { okLabel: "Remove" },
        );
        if (!ok) return;
        await removeRoot(root.id);
        refreshRootUI();
      });
    }
  }
  if (item.path) {
    addAction("Rename…", async () => {
      const oldName = item.path.split("/").pop();
      let name = await showPrompt("New name:", oldName);
      if (!name || name === oldName) return;
      if (item.type === "markdown" && !/\.(md|markdown)$/i.test(name)) name += ".md";
      const parent = item.path.split("/").slice(0, -1).join("/");
      const to = parent ? `${parent}/${name}` : name;
      await renameEntry(rootId, item.path, to);
      // If the open file was (or lived inside) the renamed entry, follow it.
      if (
        current?.root === rootId &&
        (current.path === item.path || current.path.startsWith(`${item.path}/`))
      ) {
        forgetRecent(rootId, current.path);
        current.path = current.path === item.path ? to : to + current.path.slice(item.path.length);
        crumbEl.textContent = current.path;
        recordRecent(rootId, current.path, current.kind);
        syncUrl(rootId, current.path);
      }
    });
    addAction(item.type === "dir" ? "Delete folder…" : "Delete file…", async () => {
      if (!(await showConfirm(`Delete "${item.path}"? This cannot be undone.`))) return;
      await deleteEntry(rootId, item.path);
    });
  }
  // Render first, then clamp so the menu never hangs off the viewport edge.
  actionMenu.hidden = false;
  const btnRect = anchorBtn.getBoundingClientRect();
  actionMenu.style.left = "0px";
  actionMenu.style.top = "0px";
  const rect = actionMenu.getBoundingClientRect();
  actionMenu.style.left = `${Math.max(4, Math.min(btnRect.right - rect.width, window.innerWidth - rect.width - 8))}px`;
  actionMenu.style.top = `${Math.min(btnRect.bottom + 4, window.innerHeight - rect.height - 8)}px`;
}

function addAction(label, fn) {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.onclick = async () => {
    actionMenu.hidden = true;
    try {
      await fn();
    } catch (err) {
      showAlert(err.message);
    }
  };
  actionMenu.appendChild(btn);
}

document.addEventListener("click", () => {
  actionMenu.hidden = true;
});

// ------------------------------------------------------------ quick switcher
// ⌘K / ⌘P fuzzy file palette across every root. The flat file list is
// fetched fresh on each open (fast for docs-sized roots, and never stale);
// with an empty query it shows recents instead.
let paletteFiles = null; // null = still loading
let paletteResults = [];
let paletteSel = 0;

// Classic subsequence match: every query char must appear in order. Rewards
// consecutive runs and word starts, mildly penalizes long targets.
function fuzzyScore(query, target) {
  let score = 0;
  let pos = 0;
  let run = 0;
  for (const ch of query) {
    const idx = target.indexOf(ch, pos);
    if (idx === -1) return null;
    run = idx === pos ? run + 1 : 1;
    score += run * 3;
    if (idx === 0 || "/-_. ".includes(target[idx - 1])) score += 5;
    pos = idx + 1;
  }
  return score - target.length * 0.1;
}

function paletteEntryButton(entry, i) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "palette-item" + (i === paletteSel ? " is-selected" : "");
  btn.innerHTML = ICONS[entry.type] ?? ICONS.markdown;
  const name = document.createElement("span");
  name.className = "p-name";
  name.textContent = entry.name;
  const pathEl = document.createElement("span");
  pathEl.className = "p-path";
  pathEl.textContent = entry.path;
  const badge = document.createElement("span");
  badge.className = "p-root";
  badge.textContent = entry.rootName;
  btn.append(name, pathEl, badge);
  btn.addEventListener("click", () => pickPaletteEntry(entry));
  return btn;
}

function renderPalette() {
  // Spaces are treated as soft separators ("media index" ~ "media/index.md"),
  // not literal characters — the subsequence matcher handles the rest.
  const q = paletteInput.value.toLowerCase().replace(/\s+/g, "");
  paletteList.innerHTML = "";

  if (!q) {
    paletteResults = recents
      .map((r) => {
        const root = rootsCache.find((x) => x.id === r.root);
        return (
          root && {
            type: r.kind,
            name: r.path.split("/").pop(),
            path: r.path,
            root: root.id,
            rootName: root.name,
          }
        );
      })
      .filter(Boolean)
      .slice(0, 12);
    if (paletteResults.length) {
      const title = document.createElement("div");
      title.className = "palette-section";
      title.textContent = "Recent";
      paletteList.appendChild(title);
    }
  } else {
    paletteResults = (paletteFiles ?? [])
      .map((f) => {
        const pathScore = fuzzyScore(q, f.path.toLowerCase());
        const nameScore = fuzzyScore(q, f.name.toLowerCase());
        const score = Math.max(
          pathScore ?? -Infinity,
          nameScore == null ? -Infinity : nameScore + 20, // basename hits rank higher
        );
        return score === -Infinity ? null : { ...f, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40);
  }

  paletteSel = Math.min(paletteSel, Math.max(0, paletteResults.length - 1));
  if (!paletteResults.length) {
    const empty = document.createElement("div");
    empty.className = "palette-empty";
    empty.textContent = q
      ? paletteFiles
        ? "No matching files"
        : "Loading…"
      : "Type to search across all roots";
    paletteList.appendChild(empty);
    return;
  }
  paletteResults.forEach((entry, i) => paletteList.appendChild(paletteEntryButton(entry, i)));
}

function pickPaletteEntry(entry) {
  closePalette();
  openFileSafe(entry.root, entry.path);
}

async function openPalette() {
  if (!modalOverlay.hidden) return; // never stack on top of a modal
  paletteOverlay.hidden = false;
  paletteInput.value = "";
  paletteSel = 0;
  paletteFiles = null;
  renderPalette(); // recents show instantly while the file list loads
  paletteInput.focus();

  const lists = await Promise.all(
    rootsCache.map((r) =>
      listFiles(r.id).then(
        ({ files }) => files.map((f) => ({ ...f, root: r.id, rootName: r.name })),
        () => [], // one unreadable root shouldn't break the whole palette
      ),
    ),
  );
  paletteFiles = lists.flat();
  if (!paletteOverlay.hidden) renderPalette();
}

function closePalette() {
  paletteOverlay.hidden = true;
}

paletteInput.addEventListener("input", () => {
  paletteSel = 0;
  renderPalette();
});
paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!paletteResults.length) return;
    const step = e.key === "ArrowDown" ? 1 : -1;
    paletteSel = (paletteSel + step + paletteResults.length) % paletteResults.length;
    renderPalette();
    paletteList.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    const entry = paletteResults[paletteSel];
    if (entry) pickPaletteEntry(entry);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  }
});
paletteOverlay.addEventListener("click", (e) => {
  if (e.target === paletteOverlay) closePalette();
});

// ------------------------------------------------------- keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "p")) {
    e.preventDefault();
    paletteOverlay.hidden ? openPalette() : closePalette();
  } else if (mod && !e.shiftKey && !e.altKey && e.key === "s") {
    e.preventDefault(); // browsers hijack ⌘S for "save page" — flush instead
    flushSave();
  } else if (e.key === "Escape" && !actionMenu.hidden) {
    actionMenu.hidden = true;
  }
});

// ------------------------------------------------------------- root actions
async function addRootFlow() {
  const name = await showPrompt("Root name:");
  if (!name) return;
  const dirPath = await showPrompt("Directory path (e.g. ~/Documents/notes):");
  if (!dirPath) return;
  try {
    await addRoot(name, dirPath);
    refreshRootUI();
  } catch (err) {
    if (
      err.status === 404 &&
      (await showConfirm(`${dirPath} doesn't exist. Create it?`, {
        okLabel: "Create",
        danger: false,
      }))
    ) {
      try {
        await addRoot(name, dirPath, true);
        refreshRootUI();
      } catch (err2) {
        showAlert(err2.message);
      }
    } else if (err.status !== 404) {
      showAlert(err.message);
    }
  }
}

$("addRootBtn").addEventListener("click", addRootFlow);

$("collapseAllBtn").addEventListener("click", () => {
  const labels = [...treeEl.querySelectorAll(".root-label")];
  const anyExpanded = labels.some((l) => !l.classList.contains("collapsed"));
  for (const label of labels) {
    const name = label.querySelector(".label").textContent;
    label.classList.toggle("collapsed", anyExpanded);
    if (anyExpanded) collapsedRoots.add(name);
    else collapsedRoots.delete(name);
  }
  persistCollapsed();
});

// --------------------------------------------------------------------- boot
async function boot() {
  await refreshRootUI();
  // The URL is the only source of truth for what's open — a bare "/" is the
  // dashboard (home), a refresh or shared link carries the document path.
  // Silently fall back to the dashboard if the file it names is gone.
  const route = routeFromUrl();
  if (route) await openFileSafe(route.root, route.path, { silent: true });
}

$("homeBtn").addEventListener("click", async () => {
  if (!current) return;
  if (!(await flushSave())) {
    const discard = await showConfirm(
      "Your latest edits couldn't be saved. Discard them and continue?",
      { okLabel: "Discard" },
    );
    if (!discard) return;
    dirty = false;
  }
  closeCurrent();
});

boot().catch((err) => {
  treeEl.innerHTML = `<div class="root-label">error</div><div class="row">${err.message}</div>`;
});
