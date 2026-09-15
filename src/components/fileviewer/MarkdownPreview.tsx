import { useMemo, useCallback, useState } from "react";
import { marked, type TokenizerAndRendererExtension } from "marked";
import { convertFileSrc } from "@tauri-apps/api/core";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import csharp from "highlight.js/lib/languages/csharp";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import cpp from "highlight.js/lib/languages/cpp";
import diff from "highlight.js/lib/languages/diff";
import ini from "highlight.js/lib/languages/ini";
import powershell from "highlight.js/lib/languages/powershell";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("cs", csharp);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c", cpp);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("toml", ini);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("ps1", powershell);

import { useFileViewerStore } from "../../store/fileViewerStore";
import { translateText, detectLang } from "../../hooks/useTranslate";
import s from "./FileViewer.module.css";

interface Props {
  content: string;
  filePath: string;
}

function stripFrontmatter(content: string): string {
  if (content.startsWith("---")) {
    const end = content.indexOf("\n---", 3);
    if (end !== -1) return content.slice(end + 4).trimStart();
  }
  return content;
}

const calloutTypes: Record<string, { icon: string; className: string }> = {
  note: { icon: "ℹ", className: "callout-note" },
  tip: { icon: "💡", className: "callout-tip" },
  important: { icon: "❗", className: "callout-important" },
  warning: { icon: "⚠", className: "callout-warning" },
  caution: { icon: "🔴", className: "callout-caution" },
  info: { icon: "ℹ", className: "callout-note" },
  example: { icon: "📌", className: "callout-tip" },
  abstract: { icon: "📋", className: "callout-note" },
  summary: { icon: "📋", className: "callout-note" },
  bug: { icon: "🐛", className: "callout-caution" },
  danger: { icon: "⚡", className: "callout-caution" },
  question: { icon: "❓", className: "callout-note" },
  quote: { icon: "💬", className: "callout-note" },
};

const calloutExtension: TokenizerAndRendererExtension = {
  name: "callout",
  level: "block",
  start(src: string) {
    return src.match(/^> \[!/)?.index;
  },
  tokenizer(src: string) {
    const match = src.match(
      /^> \[!(\w+)\](?:-?)[ ]*([^\n]*)\n?((?:>[ ]?[^\n]*(?:\n|$))*)/
    );
    if (match) {
      return {
        type: "callout",
        raw: match[0],
        calloutType: match[1].toLowerCase(),
        title: match[2].trim(),
        body: match[3].replace(/^>[ ]?/gm, "").trim(),
      };
    }
    return undefined;
  },
  renderer(token) {
    const info = calloutTypes[token.calloutType] || calloutTypes.note;
    const title = token.title || token.calloutType.charAt(0).toUpperCase() + token.calloutType.slice(1);
    const bodyHtml = token.body ? marked.parse(token.body) as string : "";
    return `<div class="md-callout ${info.className}">
      <div class="md-callout-title">${info.icon} ${title}</div>
      ${bodyHtml ? `<div class="md-callout-body">${bodyHtml}</div>` : ""}
    </div>`;
  },
};

function preprocessWikiLinks(content: string, baseDir: string): string {
  let result = content;

  result = result.replace(/!\[\[([^\]]+)\]\]/g, (_, imgPath: string) => {
    const resolved = baseDir ? `${baseDir}\\${imgPath.replace(/\//g, "\\")}` : imgPath;
    const fileUrl = convertFileSrc(resolved);
    return `![${imgPath}](${fileUrl})`;
  });

  result = result.replace(
    /\[\[([^\]|]+)\|([^\]]+)\]\]/g,
    (_, linkPath: string, alias: string) =>
      `<a class="md-wikilink" data-link-path="${linkPath.trim()}">${alias}</a>`
  );

  result = result.replace(
    /\[\[([^\]]+)\]\]/g,
    (_, linkPath: string) => {
      const name = linkPath.split("/").pop() || linkPath;
      return `<a class="md-wikilink" data-link-path="${linkPath.trim()}">${name}</a>`;
    }
  );

  return result;
}

marked.use({
  extensions: [calloutExtension],
  renderer: {
    code({ text, lang }: { text: string; lang?: string | null }) {
      let highlighted: string;
      if (lang && hljs.getLanguage(lang)) {
        highlighted = hljs.highlight(text, { language: lang }).value;
      } else {
        try {
          highlighted = hljs.highlightAuto(text).value;
        } catch {
          highlighted = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }
      }
      const langLabel = lang ? `<span class="md-code-lang">${lang}</span>` : "";
      return `<pre class="md-code-block">${langLabel}<code class="hljs">${highlighted}</code></pre>`;
    },
  },
});

function renderMd(content: string, filePath: string): string {
  const baseDir = filePath.replace(/\\[^\\]+$/, "");
  const stripped = stripFrontmatter(content);
  const processed = preprocessWikiLinks(stripped, baseDir);
  marked.setOptions({ breaks: true, gfm: true });
  return marked.parse(processed) as string;
}

export default function MarkdownPreview({ content, filePath }: Props) {
  const openFile = useFileViewerStore((st) => st.openFile);
  const [translated, setTranslated] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);

  const html = useMemo(() => renderMd(content, filePath), [content, filePath]);

  const translatedHtml = useMemo(() => {
    if (!translated) return null;
    return renderMd(translated, filePath);
  }, [translated, filePath]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest<HTMLElement>(".md-wikilink");
      if (!link) return;
      e.preventDefault();
      const linkPath = link.dataset.linkPath;
      if (!linkPath) return;

      const baseDir = filePath.replace(/\\[^\\]+$/, "");
      let resolved = linkPath.replace(/\//g, "\\");
      if (!resolved.includes("\\") && !resolved.includes(":")) {
        resolved = `${baseDir}\\${resolved}`;
      }
      if (!resolved.match(/\.\w+$/)) {
        resolved += ".md";
      }
      openFile(resolved);
    },
    [filePath, openFile]
  );

  const handleTranslatePage = useCallback(async () => {
    if (translated) {
      setTranslated(null);
      return;
    }
    setTranslating(true);
    try {
      const textContent = stripFrontmatter(content);
      const result = await translateText(textContent);
      setTranslated(result);
    } catch (err) {
      console.error("Translation failed:", err);
    } finally {
      setTranslating(false);
    }
  }, [content, translated]);

  const lang = useMemo(() => detectLang(stripFrontmatter(content)), [content]);

  return (
    <div className={s.mdContainer}>
      <div className={s.mdToolbar}>
        <button
          className={`${s.mdToolBtn} ${translated ? s.mdToolBtnActive : ""}`}
          onClick={handleTranslatePage}
          disabled={translating}
          title={translated ? "显示原文" : `翻译成 ${lang === "uk" ? "EN" : "UK"}`}
        >
          {translating ? (
            <span className={s.mdSpinner} />
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.545 6.714L4.11 8H3l1.862-5h1.284L8 8H6.833l-.434-1.286H4.545zm.417-1.239h1.137L5.57 3.956h-.04l-.568 1.52zM0 2a2 2 0 012-2h7a2 2 0 012 2v3h3a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2v-3H2a2 2 0 01-2-2V2zm2-1a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1V2a1 1 0 00-1-1H2zm7.138 9.995c.193.166.53.038.53-.27V7.017a1 1 0 011 .983V14a1 1 0 01-1 1H5.017a1 1 0 01-.983-1h5.104z" />
            </svg>
          )}
          {translated ? "原文" : "翻译"}
        </button>
      </div>
      <div
        className={`md-body ${s.mdWrap}`}
        dangerouslySetInnerHTML={{ __html: translatedHtml || html }}
        onClick={handleClick}
      />
    </div>
  );
}
