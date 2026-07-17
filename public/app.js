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
const ctxMenu = $("ctxMenu");
const modalOverlay = $("modalOverlay");
const modalMessage = $("modalMessage");
const modalInput = $("modalInput");
const modalCancel = $("modalCancel");
const modalOk = $("modalOk");

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
function makeAddBtn(rootId, item) {
  const btn = document.createElement("button");
  btn.className = "add-btn";
  btn.type = "button";
  btn.title = "New file or folder…";
  btn.textContent = "+";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    showContextMenu(e, rootId, item);
  });
  return btn;
}

function makeDeleteBtn(rootId, item) {
  const btn = document.createElement("button");
  btn.className = "delete-btn";
  btn.type = "button";
  btn.title = item.type === "dir" ? "Delete folder" : "Delete file";
  btn.textContent = "×";
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!(await showConfirm(`Delete "${item.path}"? This cannot be undone.`))) return;
    try {
      await deleteEntry(rootId, item.path);
    } catch (err) {
      showAlert(err.message);
    }
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
async function refreshRootUI() {
  const { roots } = await listRoots();
  renderTree(roots);
  renderDashboard(roots);
}

function renderTree(roots) {
  treeEl.innerHTML = "";
  for (const root of roots) {
    const label = document.createElement("div");
    label.className = "root-label" + (collapsedRoots.has(root.name) ? " collapsed" : "");

    const twist = document.createElement("span");
    twist.className = "twist";
    twist.textContent = "▶";
    label.appendChild(twist);

    const text = document.createElement("span");
    text.className = "label";
    text.textContent = root.name;
    label.appendChild(text);

    label.appendChild(makeStarBtn(root));
    label.appendChild(makeAddBtn(root.id, { type: "dir", path: "" }));

    const removeBtn = makeRemoveRootBtn(root);
    removeBtn.className = "remove-btn";
    removeBtn.title = "Remove root";
    removeBtn.textContent = "×";
    label.appendChild(removeBtn);

    label.addEventListener("contextmenu", (e) =>
      showContextMenu(e, root.id, { type: "dir", path: "" }),
    );
    label.addEventListener("click", () => toggleRootCollapse(label, root.name));
    treeEl.appendChild(label);

    const section = document.createElement("div");
    section.className = "root-section";
    section.dataset.root = root.id;
    treeEl.appendChild(section);

    renderChildren(section, root.id, "");
  }
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
}

function makeNode(rootId, item) {
  const node = document.createElement("div");
  node.className = "node";
  node.dataset.root = rootId;
  node.dataset.path = item.path;
  node.dataset.type = item.type;

  const row = document.createElement("div");
  row.className = "row";
  row.tabIndex = 0;
  row.innerHTML =
    (item.type === "dir" ? `<span class="twist">▶</span>` : `<span class="twist"></span>`) +
    ICONS[item.type] +
    `<span class="label">${item.name}</span>`;
  if (item.type === "dir") row.appendChild(makeAddBtn(rootId, item));
  row.appendChild(makeDeleteBtn(rootId, item));
  node.appendChild(row);

  if (item.type === "dir") {
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
  } else {
    row.addEventListener("click", () => openFile(rootId, item.path, row));
  }
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      row.click();
    }
  });
  row.addEventListener("contextmenu", (e) => showContextMenu(e, rootId, item));
  return node;
}

// ---------------------------------------------------------------- dashboard
function renderDashboard(roots) {
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
async function openFile(rootId, relPath, rowEl) {
  await flushSave();
  const { content, kind, mtimeMs } = await readFile(rootId, relPath);
  current = { root: rootId, path: relPath, kind, mtimeMs };

  treeEl.querySelectorAll(".row.active").forEach((r) => r.classList.remove("active"));
  rowEl?.classList.add("active");

  paneHead.hidden = false;
  crumbEl.textContent = relPath;
  emptyEl.hidden = true;

  editorWrap.hidden = true;
  htmlView.hidden = true;
  imgView.hidden = true;

  if (kind === "markdown") {
    editorWrap.hidden = false;
    if (editor) editor.destroy();
    $("editor").innerHTML = "";
    editor = window.createMarkdownEditor({
      element: $("editor"),
      markdown: content,
      onUpdate: scheduleSave,
    });
    setSaveState("saved");
    editor.focus();
  } else if (kind === "image") {
    imgView.hidden = false;
    imgViewImg.src = `/api/raw?root=${rootId}&path=${encodeURIComponent(relPath)}&t=${mtimeMs}`;
    setSaveState("read-only");
  } else {
    htmlView.hidden = false;
    htmlView.srcdoc = content; // sandboxed: scripts do not run
    setSaveState("read-only");
  }
}

function closeCurrent() {
  current = null;
  if (editor) {
    editor.destroy();
    editor = null;
  }
  editorWrap.hidden = true;
  htmlView.hidden = true;
  imgView.hidden = true;
  paneHead.hidden = true;
  emptyEl.hidden = false;
}

// ------------------------------------------------------------------ saving
function setSaveState(text) {
  saveStateEl.textContent = text;
  saveStateEl.classList.toggle("dirty", text === "unsaved");
}

function scheduleSave() {
  dirty = true;
  setSaveState("unsaved");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 800);
}

async function flushSave() {
  if (!dirty || !current || current.kind !== "markdown" || !editor) return;
  clearTimeout(saveTimer);
  const { mtimeMs } = await saveFile(current.root, current.path, editor.getMarkdown());
  current.mtimeMs = mtimeMs;
  dirty = false;
  setSaveState("saved");
}

window.addEventListener("beforeunload", () => {
  if (dirty) flushSave();
});

// ------------------------------------------------------- live updates (SSE)
const events = new EventSource("/api/events");
events.onopen = () => $("status").classList.add("live");
events.onerror = () => $("status").classList.remove("live");
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

// -------------------------------------------------------------- context menu
function showContextMenu(e, rootId, item) {
  e.preventDefault();
  ctxMenu.innerHTML = "";
  if (item.type === "dir") {
    const join = (name) => (item.path ? `${item.path}/${name}` : name);
    addCtxAction("New markdown file…", async () => {
      const name = await showPrompt("File name (e.g. notes.md):");
      if (!name) return;
      const file = name.endsWith(".md") ? name : `${name}.md`;
      await createEntry(rootId, join(file), "file");
    });
    addCtxAction("New folder…", async () => {
      const name = await showPrompt("Folder name:");
      if (!name) return;
      await createEntry(rootId, join(name), "folder");
    });
  }
  if (item.path) {
    addCtxAction(item.type === "dir" ? "Delete folder…" : "Delete file…", async () => {
      if (!(await showConfirm(`Delete "${item.path}"? This cannot be undone.`))) return;
      await deleteEntry(rootId, item.path);
    });
  }
  ctxMenu.hidden = false;
  ctxMenu.style.left = `${e.clientX}px`;
  ctxMenu.style.top = `${e.clientY}px`;
}

function addCtxAction(label, fn) {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.onclick = async () => {
    ctxMenu.hidden = true;
    try {
      await fn();
    } catch (err) {
      showAlert(err.message);
    }
  };
  ctxMenu.appendChild(btn);
}

document.addEventListener("click", () => {
  ctxMenu.hidden = true;
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
refreshRootUI().catch((err) => {
  treeEl.innerHTML = `<div class="root-label">error</div><div class="row">${err.message}</div>`;
});
