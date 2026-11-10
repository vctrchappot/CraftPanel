import { motdProblem, stripMotd } from "./motd";

/**
 * Rotating messages of the day: a list of messages the server list shows one after the other. Vanilla can only show
 * the one message of `server.properties`, so on Paper and Purpur the CraftPanel info plugin answers the server list
 * ping with the next message every few seconds. CraftPanel writes the list to a small text file the plugin reads.
 */

/** Where the plugin looks for the messages, relative to the server folder (`plugins/<plugin name>/`). */
export const ROTATION_FILE = "plugins/CraftPanelInfo/motd.txt";
/** Written next to the messages while the in-game info command is switched off, so the plugin hides /craftpanel. */
export const ROTATION_INFO_OFF_FILE = "plugins/CraftPanelInfo/info-off";
export const ROTATION_MAX_FRAMES = 8;
/** Seconds a message stays; the choices the dashboard offers. */
export const ROTATION_INTERVALS = [2, 3, 5, 10, 30] as const;
export const ROTATION_DEFAULT_INTERVAL = 5;

export interface MotdRotation {
  /** Seconds each message stays. */
  interval: number;
  frames: string[];
}

/** What the API reports: the rotation, and whether this server's software can show one (Paper and Purpur). */
export interface MotdRotationState extends MotdRotation {
  supported: boolean;
}

const HEADER = "# Rotating server list messages. Managed by CraftPanel: change them under Settings > Appearance.";

/** The file's form: one `frame=` line per message, with a backslash written as `\\` and a line break as `\n`. */
export function serializeRotation(rotation: MotdRotation): string {
  const escape = (frame: string) => frame.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n");
  return [HEADER, `interval=${rotation.interval}`, ...rotation.frames.map((f) => `frame=${escape(f)}`), ""].join("\n");
}

export function parseRotation(text: string): MotdRotation {
  let interval = ROTATION_DEFAULT_INTERVAL;
  const frames: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("interval=")) {
      const n = Number.parseInt(line.slice(9), 10);
      if (Number.isFinite(n) && n >= 1) interval = n;
    } else if (line.startsWith("frame=")) {
      frames.push(line.slice(6).replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c)));
    }
  }
  return { interval, frames };
}

/** What is wrong with a rotation, or null: how many messages, and for each the usual message limits. */
export function rotationProblem(rotation: MotdRotation): string | null {
  if (rotation.frames.length > ROTATION_MAX_FRAMES) return `At most ${ROTATION_MAX_FRAMES} messages can rotate.`;
  for (const [i, frame] of rotation.frames.entries()) {
    if (!stripMotd(frame).trim()) return `Message ${i + 1} is empty.`;
    const problem = motdProblem(frame);
    if (problem) return `Message ${i + 1}: ${problem}`;
  }
  return null;
}
