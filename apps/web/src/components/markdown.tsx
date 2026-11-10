import * as React from "react";
import { cn } from "@craftpanel/ui";

// A small Markdown renderer for model answers: headings, paragraphs, lists, quotes, code blocks, bold, italics,
// inline code and http(s) links. It builds React elements, never HTML, so nothing in an answer can inject markup.

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "rule" };

const BULLET = /^\s*[-*•+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", lang: fence[1], text: body.join("\n") });
      continue;
    }
    const heading = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    const bullet = BULLET.test(line);
    const numbered = line.match(NUMBERED);
    if (bullet || numbered) {
      const items: string[] = [];
      const re = bullet ? BULLET : NUMBERED;
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (m) items.push(bullet ? m[1] : m[2]);
        // A wrapped line belongs to the item above it.
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
        i++;
      }
      blocks.push({ kind: "list", ordered: !bullet, start: numbered ? Number(numbered[1]) : 1, items });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|>)/.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i])) body.push(lines[i++]);
    blocks.push({ kind: "paragraph", text: body.join("\n") });
  }
  return blocks;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(\*[^*\s][^*\n]*?\*|_[^_\s][^_\n]*?_)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

function inline(text: string, key = ""): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}${at}`;
    const [all, code, bold, italic, link] = m;
    if (code) out.push(<code key={k} className="rounded bg-muted px-1 py-px font-mono text-[0.92em]">{code.slice(1, -1)}</code>);
    else if (bold) out.push(<strong key={k} className="font-semibold">{inline(bold.slice(2, -2), k)}</strong>);
    else if (italic) out.push(<em key={k}>{inline(italic.slice(1, -1), k)}</em>);
    else if (link) {
      const [, label, href] = link.match(/^\[([^\]]+)\]\(([^)]+)\)$/) ?? [];
      out.push(
        <a key={k} href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
          {label}
        </a>,
      );
    } else out.push(all);
    last = at + all.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Line breaks inside a paragraph stay line breaks, as models write them. */
const lines = (text: string, key: string) => text.split("\n").flatMap((l, i) => (i ? [<br key={`${key}br${i}`} />, ...inline(l, `${key}l${i}`)] : inline(l, `${key}l${i}`)));

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = React.useMemo(() => parse(text), [text]);
  return (
    <div className={cn("space-y-2.5 break-words", className)}>
      {blocks.map((b, i) => {
        const k = String(i);
        switch (b.kind) {
          case "heading":
            return (
              <p key={k} role="heading" aria-level={Math.min(6, b.level + 2)} className={cn("font-semibold text-foreground", i > 0 && "pt-1")}>
                {inline(b.text, k)}
              </p>
            );
          case "paragraph":
            return <p key={k}>{lines(b.text, k)}</p>;
          case "quote":
            return (
              <blockquote key={k} className="border-l-2 border-border pl-3 text-muted-foreground">
                {lines(b.text, k)}
              </blockquote>
            );
          case "code":
            return (
              <pre key={k} className="scrollbar-thin overflow-x-auto rounded-md border border-border bg-muted/60 px-3 py-2 font-mono text-[12px] leading-relaxed">
                <code>{b.text}</code>
              </pre>
            );
          case "rule":
            return <hr key={k} className="border-border" />;
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={k} start={b.ordered ? b.start : undefined} className={cn("space-y-1 pl-5", b.ordered ? "list-decimal" : "list-disc marker:text-muted-foreground")}>
                {b.items.map((item, j) => (
                  <li key={j} className="pl-0.5">
                    {inline(item, `${k}i${j}`)}
                  </li>
                ))}
              </Tag>
            );
          }
        }
      })}
    </div>
  );
}
