import path from "node:path";

/**
 * Resolve an untrusted relative path inside `root`. Throws when the result
 * would escape the root (absolute paths, `..`, drive letters, NUL bytes).
 * Symlink escapes must additionally be checked against the filesystem.
 */
export function resolveInside(root: string, untrusted: string): string {
  if (untrusted.includes("\0")) throw new PathError("Invalid path");
  const normalized = untrusted.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith("//")) throw new PathError("Absolute paths are not allowed");
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, "." + path.posix.sep + normalized.replace(/^\/+/, ""));
  if (!isInside(rootResolved, target)) throw new PathError("Path escapes the server directory");
  return target;
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}
