import zlib from "node:zlib";

/**
 * A reader for Minecraft's NBT format (player data, level.dat). Read-only and small on purpose: enough to show a
 * player's inventory and position, not a general NBT library. Numbers of every width become `number` (longs lose
 * precision above 2^53, which nothing we read comes near), byte/int/long arrays become number arrays.
 */
export type NbtValue = number | string | NbtValue[] | NbtCompound;
export interface NbtCompound {
  [key: string]: NbtValue;
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 64;

const END = 0;
const BYTE = 1;
const SHORT = 2;
const INT = 3;
const LONG = 4;
const FLOAT = 5;
const DOUBLE = 6;
const BYTE_ARRAY = 7;
const STRING = 8;
const LIST = 9;
const COMPOUND = 10;
const INT_ARRAY = 11;
const LONG_ARRAY = 12;

class Reader {
  pos = 0;
  constructor(private buf: Buffer) {}

  private need(n: number) {
    if (this.pos + n > this.buf.length) throw new Error("NBT data ends unexpectedly");
  }
  byte() {
    this.need(1);
    return this.buf.readInt8(this.pos++);
  }
  ubyte() {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }
  short() {
    this.need(2);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  ushort() {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  int() {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  long() {
    this.need(8);
    const v = Number(this.buf.readBigInt64BE(this.pos));
    this.pos += 8;
    return v;
  }
  float() {
    this.need(4);
    const v = this.buf.readFloatBE(this.pos);
    this.pos += 4;
    return v;
  }
  double() {
    this.need(8);
    const v = this.buf.readDoubleBE(this.pos);
    this.pos += 8;
    return v;
  }
  string() {
    const len = this.ushort();
    this.need(len);
    const s = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
  /** A length that cannot be larger than the bytes left, so a corrupt file can't allocate gigabytes. */
  count(bytesPerItem: number) {
    const n = this.int();
    if (n < 0 || n * bytesPerItem > this.buf.length - this.pos) throw new Error("NBT length is out of range");
    return n;
  }
}

function payload(r: Reader, type: number, depth: number): NbtValue {
  if (depth > MAX_DEPTH) throw new Error("NBT is nested too deeply");
  switch (type) {
    case BYTE:
      return r.byte();
    case SHORT:
      return r.short();
    case INT:
      return r.int();
    case LONG:
      return r.long();
    case FLOAT:
      return r.float();
    case DOUBLE:
      return r.double();
    case STRING:
      return r.string();
    case BYTE_ARRAY: {
      const n = r.count(1);
      return Array.from({ length: n }, () => r.byte());
    }
    case INT_ARRAY: {
      const n = r.count(4);
      return Array.from({ length: n }, () => r.int());
    }
    case LONG_ARRAY: {
      const n = r.count(8);
      return Array.from({ length: n }, () => r.long());
    }
    case LIST: {
      const inner = r.ubyte();
      const n = r.count(1);
      if (inner === END && n > 0) throw new Error("NBT list has no element type");
      return Array.from({ length: n }, () => payload(r, inner, depth + 1));
    }
    case COMPOUND: {
      const out: NbtCompound = {};
      for (;;) {
        const t = r.ubyte();
        if (t === END) return out;
        const key = r.string();
        out[key] = payload(r, t, depth + 1);
      }
    }
    default:
      throw new Error(`Unknown NBT tag type ${type}`);
  }
}

/** Parse an uncompressed NBT document and return its root compound. */
export function parseNbt(buf: Buffer): NbtCompound {
  const r = new Reader(buf);
  const type = r.ubyte();
  if (type !== COMPOUND) throw new Error("NBT root is not a compound");
  r.string();
  return payload(r, COMPOUND, 0) as NbtCompound;
}

/** Minecraft writes player files gzipped; plain NBT is accepted too. */
export function parseNbtFile(raw: Buffer): NbtCompound {
  const gz = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  return parseNbt(gz ? zlib.gunzipSync(raw, { maxOutputLength: MAX_BYTES }) : raw);
}

export const isCompound = (v: unknown): v is NbtCompound => typeof v === "object" && v !== null && !Array.isArray(v);
export const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const asList = (v: unknown): NbtValue[] => (Array.isArray(v) ? v : []);
