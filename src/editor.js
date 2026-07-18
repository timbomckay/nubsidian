// Bundled by esbuild into public/editor.bundle.js (see build.js).
// Exposes a tiny factory on window so the vanilla-JS app can create a
// TipTap WYSIWYG editor that reads and writes markdown.

import { Editor, Extension, Node, mergeAttributes } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import BubbleMenu from "@tiptap/extension-bubble-menu";
import DragHandle from "@tiptap/extension-drag-handle";
import TableOfContents from "@tiptap/extension-table-of-contents";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { createLowlight, common } from "lowlight";
import Highlight from "@tiptap/extension-highlight";
import markdownItMark from "markdown-it-mark";
import markdownItContainer from "markdown-it-container";
import { Suggestion } from "@tiptap/suggestion";
import { Markdown } from "tiptap-markdown";
import tippy from "tippy.js";

const lowlight = createLowlight(common);

// tiptap-markdown only ships markdown round-tripping for CommonMark marks
// (bold/italic/code/link/strike) — Highlight needs its own serialize/parse
// storage, same pattern tiptap-markdown uses internally for its built-ins.
//
// Highlights carry a sentiment variant (bad/neutral/good/great). Neutral
// serializes as plain ==text==; the others as =={bad}text== etc. — the
// {variant} tag rides inside the markers so markdown-it-mark still
// tokenizes the whole thing, and updateDOM lifts it out into an attribute
// after render.
const HIGHLIGHT_VARIANTS = ["bad", "neutral", "good", "great"];
const HIGHLIGHT_VARIANT_RE = /^\{(bad|neutral|good|great)\}/;

const MarkdownHighlight = Highlight.extend({
  addAttributes() {
    return {
      variant: {
        default: "neutral",
        parseHTML: (el) => el.getAttribute("data-variant") || "neutral",
        renderHTML: (attrs) =>
          attrs.variant && attrs.variant !== "neutral" ? { "data-variant": attrs.variant } : {},
      },
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize: {
          open: (_state, mark) =>
            mark.attrs.variant && mark.attrs.variant !== "neutral"
              ? `=={${mark.attrs.variant}}`
              : "==",
          close: "==",
          mixable: true,
          expelEnclosingWhitespace: true,
        },
        parse: {
          setup(markdownit) {
            markdownit.use(markdownItMark);
          },
          updateDOM(element) {
            for (const markEl of element.querySelectorAll("mark")) {
              const first = markEl.firstChild;
              if (first?.nodeType !== window.Node.TEXT_NODE) continue;
              const m = first.nodeValue.match(HIGHLIGHT_VARIANT_RE);
              if (!m) continue;
              markEl.setAttribute("data-variant", m[1]);
              first.nodeValue = first.nodeValue.slice(m[0].length);
            }
          },
        },
      },
    };
  },
});

// --------------------------------------------------------------- admonition
// Callout syntax has no CommonMark or de-facto-standard form, so this picks
// a readable ::: type "Title" ... ::: container (VitePress-style) rather
// than an arbitrary invented one, and doesn't try to match any specific
// static-site generator's shortcode format — this only needs to round-trip
// cleanly through Nubsidian and stay legible as plain text elsewhere.
//
// The title is a real ProseMirror node (admonitionTitle), not a manually
// managed contenteditable island glued on in a NodeView — Safari has a
// long-standing WebKit bug where a contenteditable=true region nested
// inside a contenteditable=false one is neither clickable nor reachable by
// Tab. Routing the title through the schema like any other text node means
// typing/click/tab all go through ProseMirror's native editing, which is
// consistent across every browser.
const ADMONITION_TYPES = ["note", "tip", "warning", "danger"];
const admonitionLabel = (type) => type[0].toUpperCase() + type.slice(1);

function parseAdmonitionParams(params) {
  const match = params.trim().match(/^(\w+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*$/);
  return {
    type: ADMONITION_TYPES.includes(match?.[1]) ? match[1] : "note",
    title: match?.[2]?.replace(/\\"/g, '"') || "",
  };
}

function renderAdmonition(tokens, idx) {
  const token = tokens[idx];
  if (token.nesting !== 1) return "</div></div>\n";
  const { type, title } = parseAdmonitionParams(token.info);
  const attr = (v) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const esc = (v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    `<div data-admonition-type="${attr(type)}">` +
    `<div data-admonition-title>${esc(title)}</div>` +
    `<div data-admonition-body>\n`
  );
}

function setupAdmonitionContainers(markdownit) {
  for (const type of ADMONITION_TYPES) {
    markdownit.use(markdownItContainer, type, {
      validate: (params) => params.trim().split(/\s+/, 1)[0] === type,
      render: renderAdmonition,
    });
  }
}

const AdmonitionTitle = Node.create({
  name: "admonitionTitle",
  content: "inline*",
  parseHTML() {
    return [{ tag: "div[data-admonition-title]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { class: "admonition-title", "data-admonition-title": "" }),
      0,
    ];
  },
});

const AdmonitionBody = Node.create({
  name: "admonitionBody",
  content: "block+",
  parseHTML() {
    return [{ tag: "div[data-admonition-body]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { class: "admonition-body", "data-admonition-body": "" }),
      0,
    ];
  },
});

const Admonition = Node.create({
  name: "admonition",
  group: "block",
  content: "admonitionTitle admonitionBody",
  defining: true,
  draggable: true,
  addAttributes() {
    return {
      type: {
        default: "note",
        parseHTML: (el) => el.getAttribute("data-admonition-type") || "note",
        renderHTML: (attrs) => ({ "data-admonition-type": attrs.type }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-admonition-type]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "admonition" }), 0];
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const dom = document.createElement("div");
      dom.className = "admonition";
      dom.dataset.admonitionType = node.attrs.type;

      const chrome = document.createElement("div");
      chrome.className = "admonition-chrome";
      chrome.contentEditable = "false";

      const typeDot = document.createElement("button");
      typeDot.type = "button";
      typeDot.className = "admonition-type-dot";
      typeDot.dataset.type = node.attrs.type;
      typeDot.title = `${admonitionLabel(node.attrs.type)} — click to change`;
      // Stop propagation so ProseMirror doesn't swallow the click before it
      // reaches this button (same reasoning as the title, below).
      typeDot.addEventListener("mousedown", (e) => e.stopPropagation());
      typeDot.addEventListener("click", () => {
        if (typeof getPos !== "function") return;
        const next =
          ADMONITION_TYPES[
            (ADMONITION_TYPES.indexOf(typeDot.dataset.type) + 1) % ADMONITION_TYPES.length
          ];
        editor
          .chain()
          .focus()
          .setNodeSelection(getPos())
          .updateAttributes("admonition", { type: next })
          .run();
      });
      chrome.appendChild(typeDot);

      const content = document.createElement("div");
      content.className = "admonition-content";

      dom.appendChild(chrome);
      dom.appendChild(content);

      return {
        dom,
        contentDOM: content,
        update(updatedNode) {
          if (updatedNode.type.name !== "admonition") return false;
          dom.dataset.admonitionType = updatedNode.attrs.type;
          typeDot.dataset.type = updatedNode.attrs.type;
          typeDot.title = `${admonitionLabel(updatedNode.attrs.type)} — click to change`;
          return true;
        },
      };
    };
  },
  addKeyboardShortcuts() {
    // The title+body content model means Backspace inside the callout only
    // ever edits its children — once it's empty there is nothing left for
    // Backspace to act on, so the shell becomes undeletable from the
    // keyboard. Deleting the whole node when it's empty gives Backspace the
    // same "one more press removes the container" feel as lists and quotes.
    return {
      Backspace: () => {
        const { selection } = this.editor.state;
        if (!selection.empty) return false;
        const { $from } = selection;
        for (let depth = $from.depth; depth > 0; depth--) {
          if ($from.node(depth).type.name !== "admonition") continue;
          const admonition = $from.node(depth);
          if (admonition.textContent !== "") return false;
          const from = $from.before(depth);
          return this.editor.commands.deleteRange({ from, to: from + admonition.nodeSize });
        }
        return false;
      },
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const titleText = node.firstChild.textContent;
          const title = titleText ? ` "${titleText.replace(/"/g, '\\"')}"` : "";
          state.write(`::: ${node.attrs.type}${title}\n`);
          state.renderContent(node.lastChild);
          state.write(":::");
          state.closeBlock(node);
        },
        parse: {
          setup: setupAdmonitionContainers,
        },
      },
    };
  },
});

const slugify = (text) =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";

// ------------------------------------------------------------- bubble menu
const MARKS = [
  { name: "bold", label: "B" },
  { name: "italic", label: "I" },
  { name: "strike", label: "S" },
  { name: "code", label: "</>" },
];

function buildBubbleMenu(getEditor) {
  const el = document.createElement("div");
  el.className = "bubble-menu";

  const buttons = MARKS.map(({ name, label }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `bubble-btn bubble-btn-${name}`;
    btn.textContent = label;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const editor = getEditor();
      const chain = editor.chain().focus();
      (name === "code"
        ? chain.toggleCode()
        : chain[`toggle${name[0].toUpperCase()}${name.slice(1)}`]()
      ).run();
    });
    el.appendChild(btn);
    return { name, btn };
  });

  // One swatch per highlight sentiment; clicking the active one clears it.
  const hlButtons = HIGHLIGHT_VARIANTS.map((variant) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `bubble-hl bubble-hl-${variant}`;
    btn.title = `Highlight: ${variant}`;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const editor = getEditor();
      const chain = editor.chain().focus();
      (editor.isActive("highlight", { variant })
        ? chain.unsetHighlight()
        : chain.setHighlight({ variant })
      ).run();
    });
    el.appendChild(btn);
    return { variant, btn };
  });

  const linkBtn = document.createElement("button");
  linkBtn.type = "button";
  linkBtn.className = "bubble-btn bubble-btn-link";
  linkBtn.textContent = "Link";
  linkBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const editor = getEditor();
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    Promise.resolve(window.showPrompt?.("Link URL:")).then((url) => {
      if (url) editor.chain().focus().setLink({ href: url }).run();
    });
  });
  el.appendChild(linkBtn);

  function refresh() {
    const editor = getEditor();
    if (!editor) return;
    for (const { name, btn } of buttons) btn.classList.toggle("is-active", editor.isActive(name));
    for (const { variant, btn } of hlButtons) {
      btn.classList.toggle("is-active", editor.isActive("highlight", { variant }));
    }
    linkBtn.classList.toggle("is-active", editor.isActive("link"));
  }

  return { element: el, refresh };
}

// ------------------------------------------------------------- drag handle
function buildDragHandle() {
  const el = document.createElement("div");
  el.className = "drag-handle";
  el.innerHTML =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><circle cx="5" cy="3" r="1.3"/><circle cx="11" cy="3" r="1.3"/><circle cx="5" cy="8" r="1.3"/><circle cx="11" cy="8" r="1.3"/><circle cx="5" cy="13" r="1.3"/><circle cx="11" cy="13" r="1.3"/></svg>';
  return el;
}

// ---------------------------------------------------------- slash command
const SLASH_ITEMS = [
  { title: "Text", run: (c) => c.setParagraph() },
  { title: "Heading 1", run: (c) => c.setNode("heading", { level: 1 }) },
  { title: "Heading 2", run: (c) => c.setNode("heading", { level: 2 }) },
  { title: "Heading 3", run: (c) => c.setNode("heading", { level: 3 }) },
  { title: "Bullet List", run: (c) => c.toggleBulletList() },
  { title: "Numbered List", run: (c) => c.toggleOrderedList() },
  { title: "Task List", run: (c) => c.toggleTaskList() },
  { title: "Quote", run: (c) => c.toggleBlockquote() },
  { title: "Code Block", run: (c) => c.toggleCodeBlock() },
  { title: "Divider", run: (c) => c.setHorizontalRule() },
  {
    title: "Callout",
    run: (c) =>
      c
        .insertContent({
          type: "admonition",
          attrs: { type: "note" },
          content: [
            { type: "admonitionTitle" },
            { type: "admonitionBody", content: [{ type: "paragraph" }] },
          ],
        })
        // insertContent leaves the cursor at the end of what it inserted —
        // the empty body paragraph. Walk back up to the admonition and drop
        // the cursor in its title instead (+1 into the admonition, +1 into
        // the title node).
        .command(({ tr, dispatch }) => {
          if (!dispatch) return true;
          const { $from } = tr.selection;
          for (let depth = $from.depth; depth > 0; depth--) {
            if ($from.node(depth).type.name !== "admonition") continue;
            tr.setSelection(TextSelection.create(tr.doc, $from.before(depth) + 2));
            break;
          }
          return true;
        }),
  },
];

function renderSlashList(listEl, items, selected, onPick) {
  listEl.innerHTML = "";
  items.forEach((item, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slash-item" + (i === selected ? " is-selected" : "");
    btn.textContent = item.title;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      onPick(item);
    });
    listEl.appendChild(btn);
  });
}

const SlashCommand = Extension.create({
  name: "slashCommand",
  addProseMirrorPlugins() {
    let selected = 0;
    let listEl;
    let popup;

    const pick = (item, range) => {
      const editor = this.editor;
      item.run(editor.chain().focus().deleteRange(range)).run();
    };

    return [
      Suggestion({
        editor: this.editor,
        char: "/",
        items: ({ query }) =>
          SLASH_ITEMS.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())),
        command: ({ editor, range, props }) => pick(props, range),
        render: () => ({
          onStart: (props) => {
            selected = 0;
            const root = document.createElement("div");
            root.className = "slash-menu";
            listEl = document.createElement("div");
            listEl.className = "slash-menu-list";
            root.appendChild(listEl);
            renderSlashList(listEl, props.items, selected, (item) => pick(item, props.range));

            popup = tippy(document.body, {
              getReferenceClientRect: props.clientRect,
              appendTo: () => document.body,
              content: root,
              showOnCreate: true,
              interactive: true,
              trigger: "manual",
              placement: "bottom-start",
              arrow: false,
              theme: "slash-menu",
            });
          },
          onUpdate: (props) => {
            selected = 0;
            renderSlashList(listEl, props.items, selected, (item) => pick(item, props.range));
            popup?.setProps({ getReferenceClientRect: props.clientRect });
          },
          onKeyDown: (props) => {
            const items = listEl ? [...listEl.children] : [];
            if (!items.length) return false;
            if (props.event.key === "Escape") {
              popup?.hide();
              return true;
            }
            if (props.event.key === "ArrowDown") {
              selected = (selected + 1) % items.length;
              items.forEach((el, i) => el.classList.toggle("is-selected", i === selected));
              return true;
            }
            if (props.event.key === "ArrowUp") {
              selected = (selected - 1 + items.length) % items.length;
              items.forEach((el, i) => el.classList.toggle("is-selected", i === selected));
              return true;
            }
            if (props.event.key === "Enter") {
              items[selected]?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
              return true;
            }
            return false;
          },
          onExit: () => {
            popup?.destroy();
            popup = undefined;
          },
        }),
      }),
    ];
  },
});

// -------------------------------------------------------------------- API
window.createMarkdownEditor = function createMarkdownEditor({
  element,
  markdown,
  onUpdate,
  onTocUpdate,
}) {
  let editor;
  const bubbleMenu = buildBubbleMenu(() => editor);
  const dragHandleEl = buildDragHandle();
  const scrollParent = element.closest(".editor-wrap") || window;

  // The extension hides itself on the ProseMirror view's `mouseleave`, gated
  // by `event.relatedTarget` pointing at a descendant of its popper wrapper.
  // relatedTarget is unreliable during fast real-mouse movement (browsers can
  // report it as null), so the handle can vanish while still hovered. Tippy
  // keeps its instance on the reference element (view.dom) even after fully
  // unmounting the popper, so re-showing from there on any gutter mousemove
  // recovers it without depending on that flaky check.
  let hasHoveredNode = false;
  const recoverDragHandle = (e) => {
    if (!hasHoveredNode) return;
    const dom = editor.view.dom;
    if (e.clientX >= dom.getBoundingClientRect().left) return;
    const inst = dom._tippy;
    if (inst && !inst.state.isShown) inst.show();
  };
  element.addEventListener("mousemove", recoverDragHandle);

  editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      CodeBlockLowlight.configure({ lowlight }),
      MarkdownHighlight,
      Admonition,
      AdmonitionTitle,
      AdmonitionBody,
      Link.configure({ openOnClick: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      BubbleMenu.configure({
        element: bubbleMenu.element,
        shouldShow: ({ state }) => !state.selection.empty,
      }),
      DragHandle.configure({
        render: () => dragHandleEl,
        tippyOptions: { duration: [150, 500], offset: [0, 4] },
        onNodeChange: ({ node }) => {
          if (node) hasHoveredNode = true;
        },
      }),
      TableOfContents.configure({
        getId: slugify,
        scrollParent: () => scrollParent,
        onUpdate: (items) => onTocUpdate?.(items),
      }),
      SlashCommand,
      Markdown.configure({
        html: false,
        linkify: true,
        breaks: false,
      }),
    ],
    content: markdown,
    onUpdate: ({ editor }) => {
      onUpdate(editor.storage.markdown.getMarkdown());
    },
    onSelectionUpdate: () => bubbleMenu.refresh(),
    onTransaction: () => bubbleMenu.refresh(),
  });

  return {
    getMarkdown: () => editor.storage.markdown.getMarkdown(),
    setMarkdown: (md) => editor.commands.setContent(md),
    focus: () => editor.commands.focus(),
    scrollToHeading: (id) => {
      element.querySelector(`[data-toc-id="${CSS.escape(id)}"]`)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    },
    destroy: () => {
      element.removeEventListener("mousemove", recoverDragHandle);
      editor.destroy();
      bubbleMenu.element.remove();
      dragHandleEl.remove();
    },
  };
};
