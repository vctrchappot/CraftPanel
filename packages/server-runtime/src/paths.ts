import os from "node:os";
import path from "node:path";

/** Platform-appropriate data directory; override with CRAFTPANEL_DATA_DIR. */
export function defaultDataDir(): string {
  if (process.env.CRAFTPANEL_DATA_DIR) return path.resolve(process.env.CRAFTPANEL_DATA_DIR);
  const home = os.homedir();
  switch (process.platform) {
    case "win32":
      return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "CraftPanel");
    case "darwin":
      return path.join(home, "Library", "Application Support", "CraftPanel");
    default:
      return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "craftpanel");
  }
}

export interface DataLayout {
  root: string;
  database: string;
  servers: string;
  backups: string;
  java: string;
  cache: string;
  logs: string;
  tmp: string;
}

export function dataLayout(root = defaultDataDir()): DataLayout {
  return {
    root,
    database: path.join(root, "craftpanel.db"),
    servers: path.join(root, "servers"),
    backups: path.join(root, "backups"),
    java: path.join(root, "runtimes", "java"),
    cache: path.join(root, "cache"),
    logs: path.join(root, "logs"),
    tmp: path.join(root, "tmp"),
  };
}
