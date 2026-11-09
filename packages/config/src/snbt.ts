import type { NbtCompound, NbtValue } from "./nbt";

/**
 * A reader for SNBT, the text form of NBT that `/data get` prints (`{Health: 20.0f, Inventory: [{Slot: 0b, …}]}`).
 * It returns the same shapes as `parseNbt`, so anything that reads a player's `.dat` file can read a live answer
 * from the running game too. Numbers lose their suffix, booleans become 1 and 0, typed arrays become plain lists.
 */
const MAX_CHARS = 4 * 1024 * 1024;
const MAX_DEPTH = 64;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[bBsSlLfFdD]?$/;
const UNQUOTED = /[0-9A-Za-z_.+\-]/;

class Reader {
  i = 0;
  constructor(private s: string) {}

  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  peek() {
    this.ws();
    return this.s[this.i];
  }
  expect(c: string) {
    if (this.peek() !== c) throw new Error(`SNBT: expected "${c}" at ${this.i}`);
    this.i++;
  }

  quoted(): string {
    const q = this.s[this.i++];
    let out = "";
    while (this.i < this.s.length) {
      const c = this.s[this.i++];
      if (c === q) return out;
      if (c === "\\") {
        const n = this.s[this.i++];
        out += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
      } else out += c;
    }
    throw new Error("SNBT: unterminated string");
  }

  token(): string {
    const start = this.i;
    while (this.i < this.s.length && UNQUOTED.test(this.s[this.i])) this.i++;
    if (this.i === start) throw new Error(`SNBT: unexpected "${this.s[this.i] ?? "end"}" at ${this.i}`);
    return this.s.slice(start, this.i);
  }

  key(): string {
    const c = this.peek();
    return c === '"' || c === "'" ? this.quoted() : this.token();
  }

  value(depth: number): NbtValue {
    if (depth > MAX_DEPTH) throw new Error("SNBT is nested too deeply");
    const c = this.peek();
    if (c === "{") {
      this.i++;
      const out: NbtCompound = {};
      if (this.peek() === "}") {
        this.i++;
        return out;
      }
      for (;;) {
        const k = this.key();
        this.expect(":");
        out[k] = this.value(depth + 1);
        const n = this.peek();
        this.i++;
        if (n === "}") return out;
        if (n !== ",") throw new Error(`SNBT: expected "," or "}" at ${this.i - 1}`);
      }
    }
    if (c === "[") {
      this.i++;
      // `[B;`, `[I;` and `[L;` start a typed array.
      const typed = /^\s*[BIL]\s*;/.exec(this.s.slice(this.i, this.i + 8));
      if (typed) this.i += typed[0].length;
      const out: NbtValue[] = [];
      if (this.peek() === "]") {
        this.i++;
        return out;
      }
      for (;;) {
        out.push(this.value(depth + 1));
        const n = this.peek();
        this.i++;
        if (n === "]") return out;
        if (n !== ",") throw new Error(`SNBT: expected "," or "]" at ${this.i - 1}`);
      }
    }
    if (c === '"' || c === "'") return this.quoted();
    const t = this.token();
    if (t === "true") return 1;
    if (t === "false") return 0;
    return NUMBER.test(t) ? Number(t.replace(/[bBsSlLfFdD]$/, "")) : t;
  }
}

/** Parse the value in an SNBT text; throws on anything malformed. */
export function parseSnbt(text: string): NbtValue {
  if (text.length > MAX_CHARS) throw new Error("SNBT is too large");
  const r = new Reader(text);
  const v = r.value(0);
  if (r.peek() !== undefined) throw new Error(`SNBT: unexpected text at ${r.i}`);
  return v;
}
