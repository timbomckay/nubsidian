// Bundled by esbuild into public/editor.bundle.js (see build.js).
// Exposes a tiny factory on window so the vanilla-JS app can create a
// TipTap WYSIWYG editor that reads and writes markdown.

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "tiptap-markdown";

window.createMarkdownEditor = function createMarkdownEditor({
  element,
  markdown,
  onUpdate,
}) {
  const editor = new Editor({
    element,
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
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
  });

  return {
    getMarkdown: () => editor.storage.markdown.getMarkdown(),
    setMarkdown: (md) => editor.commands.setContent(md),
    focus: () => editor.commands.focus(),
    destroy: () => editor.destroy(),
  };
};
