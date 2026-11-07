// The root package.json is the single source of truth for the version (bumped by scripts/release.mjs).
import { version } from "../../../package.json";

/** Application version shown in the dashboard, the update check and the in-game info command. */
export const CRAFTPANEL_VERSION: string = version;
export const CRAFTPANEL_REPO = "vctrchappot/CraftPanel";
export const CRAFTPANEL_REPO_URL = `https://github.com/${CRAFTPANEL_REPO}`;

/** Original author, credited in the dashboard, the README and the in-game info card. */
export const CRAFTPANEL_AUTHOR = {
  name: "Victor",
  handle: "vctrchappot",
  github: "https://github.com/vctrchappot",
  website: "https://www.vctr.site",
} as const;
