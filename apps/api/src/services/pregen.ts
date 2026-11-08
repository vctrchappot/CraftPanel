import { conflict, SOFTWARE_INFO, type ConsoleLine } from "@craftpanel/shared";
import type { Actor } from "./activity";
import type { GameService } from "./game";
import type { ServerRow, ServerService } from "./servers";

/**
 * World pre-generation with Chunky (Modrinth), like hosting panels offer it: generating the
 * terrain ahead of time avoids lag spikes when players explore, which matters most on a Pi.
 * Chunky is a Paper/Purpur plugin and a Fabric mod (Fabric needs Fabric API); Vanilla can't load it.
 */
export const CHUNKY_PROJECT = "fALzjamp";
const FABRIC_API_PROJECT = "P7dR8mSH";

export interface PregenTask {
  state: "running" | "finished" | "paused" | "stopped";
  world: string;
  chunks: number;
  percent: number;
  eta: string | null;
  rate: number | null;
  at: number;
}

export interface PregenStatus {
  supported: boolean;
  installed: boolean;
  /** Chunky is installed but the server must (re)start to load it. */
  restartNeeded: boolean;
  running: boolean;
  task: PregenTask | null;
}

// "[Chunky] Task running for world. Processed: 1234 chunks (5.67%), ETA: 0:12:34, Rate: 123.4 cps, Current: 12, -3"
// "[Chunky] Task finished for minecraft:overworld. Processed: 4225 chunks (100.00%), Total time: 0:00:42"
const PROGRESS = /\[Chunky\] Task (running|finished) for (\S+?)\. Processed: (\d+) chunks \(([\d.]+)%\)(?:, ETA: ([\d:]+))?(?:, Rate: ([\d.]+) cps)?/;
// Pausing prints "Task paused for world." followed by "Task stopped for world."; cancelling prints
// "Cancelling all tasks." and then "Task stopped …". "started"/"continuing" come before the first progress line.
const EVENT = /\[Chunky\] Task (paused|stopped|cancelled|continuing) for (\S+?)\.|\[Chunky\] Task started in (\S+) for/;

/** The newest Chunky progress in the console output. */
export function parsePregen(lines: Pick<ConsoleLine, "text" | "ts">[]): PregenTask | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const { text, ts } = lines[i]!;
    const p = PROGRESS.exec(text);
    if (p) return { state: p[1] as "running" | "finished", world: p[2]!, chunks: Number(p[3]), percent: Number(p[4]), eta: p[5] ?? null, rate: p[6] ? Number(p[6]) : null, at: ts };
    const e = EVENT.exec(text);
    if (!e) continue;
    let event = e[1] ?? "started";
    const world = e[2] ?? e[3]!;
    if (event === "stopped" && i > 0 && /\[Chunky\] Task paused for/.test(lines[i - 1]!.text)) event = "paused";
    const before = event === "started" ? null : parsePregen(lines.slice(0, i));
    const state = event === "paused" ? "paused" : event === "continuing" || event === "started" ? "running" : "stopped";
    return { state, world, chunks: before?.chunks ?? 0, percent: before?.percent ?? 0, eta: null, rate: null, at: ts };
  }
  return null;
}

export class PregenService {
  constructor(
    private servers: ServerService,
    private game: GameService,
  ) {}

  private async chunky(row: ServerRow) {
    return (await this.game.plugins(row)).find((p) => /^chunky\b/i.test(p.name ?? "") || /^chunky/i.test(p.file));
  }

  async status(row: ServerRow): Promise<PregenStatus> {
    const supported = !!SOFTWARE_INFO[row.software].addons && !SOFTWARE_INFO[row.software].proxy;
    const plugin = supported ? await this.chunky(row) : undefined;
    const running = this.servers.agent.isRunning(row.id);
    return {
      supported,
      installed: !!plugin?.enabled,
      restartNeeded: !!plugin?.enabled && running && this.servers.restartRequired.has(row.id),
      running,
      task: running ? parsePregen(this.servers.agent.history(row.id, 2000)) : null,
    };
  }

  async install(row: ServerRow, actor: Actor) {
    if (SOFTWARE_INFO[row.software].proxy) throw conflict("A proxy has no world to pre-generate. Pre-generate on the servers behind it.");
    if (!SOFTWARE_INFO[row.software].addons) throw conflict("Vanilla servers can't load Chunky. Switch to Paper, Purpur, Fabric or NeoForge first.");
    if (await this.chunky(row)) return;
    const res = await this.game.installFromModrinth(row, CHUNKY_PROJECT, undefined, actor);
    if (row.software === "fabric" && res.requiredDependencies.includes(FABRIC_API_PROJECT) && !(await this.game.plugins(row)).some((p) => /fabric api/i.test(p.name ?? ""))) {
      await this.game.installFromModrinth(row, FABRIC_API_PROJECT, undefined, actor);
    }
  }

  /** Chunky console commands; output arrives in the console and is parsed by status(). */
  async control(row: ServerRow, action: "start" | "pause" | "continue" | "cancel", radius?: number) {
    const s = await this.status(row);
    if (!s.installed) throw conflict("Install Chunky first");
    if (!s.running) throw conflict("Start the server first");
    if (s.restartNeeded) throw conflict("Restart the server so it loads Chunky");
    const commands =
      action === "start"
        ? // Centre on the world spawn; "confirm" replaces an older unfinished task instead of asking.
          ["chunky spawn", `chunky radius ${radius ?? 1000}`, "chunky start", "chunky confirm"]
        : action === "cancel"
          ? ["chunky cancel", "chunky confirm"]
          : [`chunky ${action}`];
    for (const c of commands) await this.servers.sendCommand(row.id, c);
  }
}
