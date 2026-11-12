import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Per-server OS isolation on Linux service installs. The installer creates a pool of
 * `<service user>-game-NN` accounts (each with its own group) and adds the service user to
 * every pool group. The runtime holds only CAP_SETUID/SETGID/CHOWN/FOWNER/KILL and starts
 * Java through util-linux `setpriv`, which switches to the slot's account, drops all
 * supplementary groups and clears inheritable (and thereby ambient) capabilities before
 * exec. `NoNewPrivileges` stays on, so file capabilities cannot be regained either.
 */
// CAP_CHOWN 0, CAP_FOWNER 3, CAP_KILL 5, CAP_SETGID 6, CAP_SETUID 7.
const REQUIRED_CAPS = [0, 3, 5, 6, 7];
/** Holds the map's password hash; the game never needs it. */
const PRIVATE_FILES = new Set([".craftpanel-map.json"]);

export interface GameSlot { index: number; name: string; uid: number; gid: number }
export interface IsolationStatus { mode: "isolated" | "shared"; reason?: string; accounts?: number }
export type Isolation = { mode: "isolated"; setpriv: string; slots: GameSlot[] } | { mode: "shared"; reason: string };

export function isolationStatus(isolation: Isolation): IsolationStatus {
  return isolation.mode === "isolated" ? { mode: "isolated", accounts: isolation.slots.length } : { mode: "shared", reason: isolation.reason };
}

export async function detectIsolation(env: NodeJS.ProcessEnv = process.env): Promise<Isolation> {
  if (process.platform !== "linux") return { mode: "shared", reason: "Per-server isolation is available on Linux service installs" };
  if (env.CRAFTPANEL_ISOLATION === "off") return { mode: "shared", reason: "Disabled by CRAFTPANEL_ISOLATION=off" };
  const passwd = await fs.readFile("/etc/passwd", "utf8").catch(() => "");
  const prefix = `${os.userInfo().username}-game-`;
  const groups = new Set(process.getgroups?.() ?? []);
  const slots: GameSlot[] = [];
  for (const line of passwd.split("\n")) {
    const [name, , uid, gid] = line.split(":");
    const m = name?.startsWith(prefix) ? /^(\d{1,4})$/.exec(name.slice(prefix.length)) : null;
    if (!m || !/^\d+$/.test(uid ?? "") || !/^\d+$/.test(gid ?? "")) continue;
    const slot = { index: Number(m[1]), name, uid: Number(uid), gid: Number(gid) };
    // Never run a game as root, as ourselves, or with a group we cannot manage.
    if (slot.uid === 0 || slot.gid === 0 || slot.uid === process.getuid!() || !groups.has(slot.gid)) continue;
    slots.push(slot);
  }
  if (!slots.length) return { mode: "shared", reason: "No game accounts; install CraftPanel as a Linux service to isolate servers" };
  const status = await fs.readFile("/proc/self/status", "utf8").catch(() => "");
  const effective = BigInt("0x" + (/^CapEff:\s*([0-9a-f]+)/m.exec(status)?.[1] ?? "0"));
  if (!REQUIRED_CAPS.every((cap) => (effective >> BigInt(cap)) & 1n)) return { mode: "shared", reason: "The runtime service lacks the capabilities for per-server accounts" };
  let setpriv = "";
  for (const candidate of ["/usr/bin/setpriv", "/bin/setpriv"]) if (await fs.access(candidate).then(() => true, () => false)) { setpriv = candidate; break; }
  if (!setpriv) return { mode: "shared", reason: "setpriv (util-linux) is missing" };
  slots.sort((a, b) => a.index - b.index);
  return { mode: "isolated", setpriv, slots };
}

/** Runs `file args` as the slot's account without groups or capabilities. */
export function asGameAccount(setpriv: string, slot: GameSlot, file: string, args: string[]) {
  return { file: setpriv, args: [`--reuid=${slot.uid}`, `--regid=${slot.gid}`, "--clear-groups", "--inh-caps=-all", "--", file, ...args] };
}

/** PIDs owned by a uid (leftovers a plugin may have forked off). */
export async function processesOf(uid: number): Promise<number[]> {
  const pids: number[] = [];
  for (const entry of await fs.readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const status = await fs.readFile(`/proc/${entry}/status`, "utf8").catch(() => "");
    const real = /^Uid:\s*(\d+)/m.exec(status)?.[1];
    if (real !== undefined && Number(real) === uid) pids.push(Number(entry));
  }
  return pids;
}

/** Kills every process of a slot account. Called only while its server is stopped. */
export async function killLeftovers(uid: number): Promise<number> {
  let killed = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const pids = await processesOf(uid);
    if (!pids.length) return killed;
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); killed++; } catch { /* already gone */ } }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Processes of the previous server run are still alive; stop them before starting again");
}

/**
 * Gives the slot's group read/write access to the whole server directory, closes it to
 * everyone else, and makes new entries inherit the group (setgid directories). Owners stay.
 * Symlinks are never followed; leftover game processes must be gone first so nothing can
 * swap an entry for a link while this runs.
 */
export async function prepareServerDirectory(directory: string, slot: GameSlot, dataDir: string): Promise<void> {
  await shareTree(await serverRoot(directory, dataDir), slot.gid);
}

async function serverRoot(directory: string, dataDir: string) {
  const root = path.resolve(directory);
  const data = path.resolve(dataDir);
  if (root === path.parse(root).root || data === root || data.startsWith(root + path.sep) || root.startsWith(path.join(data, "runtime") + path.sep)) throw new Error("Refusing to prepare this directory for a game account");
  const top = await fs.lstat(root);
  if (!top.isDirectory()) throw new Error("The server directory is not a directory");
  // Only directories CraftPanel created or adopted carry the marker.
  if (!(await fs.lstat(path.join(root, ".craftpanel")).catch(() => null))?.isFile()) throw new Error("The server directory has no CraftPanel marker");
  return root;
}

/**
 * Shares one entry (recursively for directories) of a running server with the dashboard.
 * Minecraft writes level.dat and player data through Java temp files, which are always 0600.
 * The game may race this by swapping entries for links; chmod then only adds group bits to a
 * file of the link's target group (never the game's), and ProtectSystem limits it to the data directory.
 */
export async function shareServerPath(directory: string, rel: string, slot: GameSlot, dataDir: string): Promise<void> {
  const root = await serverRoot(directory, dataDir);
  const target = path.resolve(root, rel || ".");
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Path is outside the server directory");
  // No links on the way down; the entry itself is never followed.
  for (let p = root; p !== target;) {
    p = path.join(p, path.relative(p, target).split(path.sep)[0]);
    const st = await fs.lstat(p).catch(() => null);
    if (!st) return;
    if (st.isSymbolicLink()) return;
  }
  const st = await fs.lstat(target);
  if (st.isDirectory()) await shareTree(target, slot.gid);
  else await fixEntry(target, slot.gid, st);
}

async function shareTree(root: string, gid: number) {
  // A running server may delete entries while this walks.
  const gone = (err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; return null; };
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    if (await fixEntry(dir, gid).then(() => true, gone) === null) continue;
    for (const name of await fs.readdir(dir).catch(gone) ?? []) {
      const child = path.join(dir, name);
      const st = await fs.lstat(child).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) stack.push(child);
      else await fixEntry(child, gid, st).catch(gone);
    }
  }
}

async function fixEntry(file: string, gid: number, known?: Awaited<ReturnType<typeof fs.lstat>>) {
  const st = known ?? await fs.lstat(file);
  if (st.gid !== gid) await fs.lchown(file, -1, gid);
  if (st.isSymbolicLink()) return;
  const mode = Number(st.mode) & 0o7777;
  let desired: number;
  if (st.isDirectory()) desired = (mode & 0o700) | 0o2070;
  else if (st.isFile()) desired = PRIVATE_FILES.has(path.basename(file)) ? mode & 0o700 : (mode & 0o700) | 0o060 | (mode & 0o100 ? 0o010 : 0);
  else return;
  if (mode !== desired) await fs.chmod(file, desired);
}

/**
 * Game accounts may traverse the data directory to reach their server and the bundled
 * Java runtimes, but read nothing else. Top-level entries lose all "other" access.
 */
export async function protectDataDirectory(dataDir: string): Promise<void> {
  const traverse = async (dir: string) => {
    const st = await fs.lstat(dir).catch(() => null);
    if (!st?.isDirectory() || st.uid !== process.getuid!()) return;
    const mode = Number(st.mode) & 0o7777;
    if ((mode & 0o007) !== 0o001) await fs.chmod(dir, (mode & ~0o007) | 0o001);
  };
  const close = async (entry: string) => {
    const st = await fs.lstat(entry).catch(() => null);
    if (!st || st.isSymbolicLink() || (st.uid !== process.getuid!() && !st.isDirectory())) return;
    const mode = Number(st.mode) & 0o7777;
    if (mode & 0o007) await fs.chmod(entry, mode & ~0o007);
  };
  await traverse(dataDir);
  for (const name of await fs.readdir(dataDir)) {
    if (name === "servers" || name === "runtimes") continue;
    await close(path.join(dataDir, name));
  }
  const servers = path.join(dataDir, "servers");
  await traverse(servers);
  for (const name of await fs.readdir(servers).catch(() => [] as string[])) await close(path.join(servers, name));
  const runtimes = path.join(dataDir, "runtimes");
  await traverse(runtimes);
  for (const name of await fs.readdir(runtimes).catch(() => [] as string[])) {
    if (name !== "java") await close(path.join(runtimes, name));
  }
  await traverse(path.join(runtimes, "java"));
}

/** A Java runtime that CraftPanel downloaded into the data directory must be readable by game accounts. */
export async function shareJavaRuntime(javaPath: string, dataDir: string): Promise<void> {
  const javaRoot = path.join(path.resolve(dataDir), "runtimes", "java");
  const resolved = path.resolve(javaPath);
  if (!resolved.startsWith(javaRoot + path.sep)) return;
  const top = path.join(javaRoot, path.relative(javaRoot, resolved).split(path.sep)[0]);
  const stack = [top];
  while (stack.length) {
    const entry = stack.pop()!;
    const st = await fs.lstat(entry).catch(() => null);
    if (!st || st.isSymbolicLink() || st.uid !== process.getuid!()) continue;
    const mode = Number(st.mode) & 0o7777;
    if (st.isDirectory()) {
      if ((mode & 0o005) !== 0o005) await fs.chmod(entry, mode | 0o005);
      for (const name of await fs.readdir(entry)) stack.push(path.join(entry, name));
    } else if (st.isFile()) {
      const desired = mode | 0o004 | (mode & 0o100 ? 0o001 : 0);
      if (desired !== mode) await fs.chmod(entry, desired);
    }
  }
}

/** Authoritative check under the game account: can it write the directory and run Java? */
export async function probeAsGame(setpriv: string, slot: GameSlot, directory: string, javaPath: string): Promise<string | null> {
  const script = "const fs=require('fs');const [d,j]=process.argv.slice(1);" +
    "try{fs.accessSync(d,fs.constants.W_OK|fs.constants.X_OK)}catch{console.log('directory');process.exit(0)}" +
    "try{fs.accessSync(j,fs.constants.X_OK)}catch{console.log('java');process.exit(0)}console.log('ok')";
  const { file, args } = asGameAccount(setpriv, slot, process.execPath, ["-e", script, directory, javaPath]);
  try {
    const { stdout } = await run(file, args, { cwd: "/", timeout: 15_000, maxBuffer: 4096 });
    const result = stdout.trim();
    if (result === "ok") return null;
    if (result === "directory") return `The game account ${slot.name} cannot reach ${directory}; every parent directory needs execute permission for others (chmod o+x)`;
    if (result === "java") return `The game account ${slot.name} cannot run ${javaPath}; make the Java installation readable for others`;
    return `Unexpected probe result for ${slot.name}`;
  } catch (error) {
    return `Could not switch to the game account ${slot.name}: ${(error as Error).message.split("\n")[0]}`;
  }
}
