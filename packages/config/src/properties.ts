/**
 * Java `.properties` parser/serializer that preserves comments, ordering and
 * unknown keys so CraftPanel never destroys hand-written configuration.
 */

type Line =
  | { kind: "raw"; text: string }
  | { kind: "entry"; key: string; value: string };

export class PropertiesDocument {
  private lines: Line[] = [];

  static parse(text: string): PropertiesDocument {
    const doc = new PropertiesDocument();
    // Join continuation lines (odd number of trailing backslashes).
    const physical = text.replace(/^﻿/, "").split(/\r?\n/);
    const logical: string[] = [];
    let buffer: string | null = null;
    for (const line of physical) {
      const current: string = buffer === null ? line : buffer + line.replace(/^\s+/, "");
      const trailing = /(\\+)$/.exec(current);
      if (trailing && trailing[1].length % 2 === 1) {
        buffer = current.slice(0, -1);
        continue;
      }
      buffer = null;
      logical.push(current);
    }
    if (buffer !== null) logical.push(buffer);
    if (logical.length > 0 && logical[logical.length - 1] === "") logical.pop();

    for (const line of logical) {
      const trimmed = line.trimStart();
      if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("!")) {
        doc.lines.push({ kind: "raw", text: line });
        continue;
      }
      const { key, value } = splitEntry(trimmed);
      doc.lines.push({ kind: "entry", key: unescape(key), value: unescape(value) });
    }
    return doc;
  }

  get(key: string): string | undefined {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      if (l.kind === "entry" && l.key === key) return l.value;
    }
    return undefined;
  }

  set(key: string, value: string): void {
    if (/[\r\n]/.test(value)) throw new Error(`Value for ${key} must be a single line`);
    const existing = this.lines.find((l): l is Extract<Line, { kind: "entry" }> => l.kind === "entry" && l.key === key);
    if (existing) existing.value = value;
    else this.lines.push({ kind: "entry", key, value });
  }

  delete(key: string): void {
    this.lines = this.lines.filter((l) => !(l.kind === "entry" && l.key === key));
  }

  toObject(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const l of this.lines) if (l.kind === "entry") out[l.key] = l.value;
    return out;
  }

  keys(): string[] {
    return Object.keys(this.toObject());
  }

  serialize(): string {
    return (
      this.lines
        .map((l) => (l.kind === "raw" ? l.text : `${escape(l.key, true)}=${escape(l.value, false)}`))
        .join("\n") + "\n"
    );
  }
}

function splitEntry(line: string): { key: string; value: string } {
  let i = 0;
  let key = "";
  while (i < line.length) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) {
      key += c + line[i + 1];
      i += 2;
      continue;
    }
    if (c === "=" || c === ":" || c === " " || c === "\t" || c === "\f") break;
    key += c;
    i++;
  }
  // Skip whitespace, then at most one separator, then whitespace.
  while (i < line.length && /[ \t\f]/.test(line[i])) i++;
  if (i < line.length && (line[i] === "=" || line[i] === ":")) i++;
  while (i < line.length && /[ \t\f]/.test(line[i])) i++;
  return { key, value: line.slice(i) };
}

function unescape(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\" || i + 1 >= s.length) {
      out += c;
      continue;
    }
    const n = s[++i];
    switch (n) {
      case "t": out += "\t"; break;
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "f": out += "\f"; break;
      case "u": {
        const hex = s.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else out += "u";
        break;
      }
      default: out += n;
    }
  }
  return out;
}

function escape(s: string, isKey: boolean): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = c.charCodeAt(0);
    if (c === "\\") out += "\\\\";
    else if (c === "=" || c === ":" || c === "#" || c === "!") out += "\\" + c;
    else if (c === " " && (isKey || i === 0)) out += "\\ ";
    else if (c === "\t") out += "\\t";
    else if (code < 0x20 || code > 0x7e) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += c;
  }
  return out;
}
