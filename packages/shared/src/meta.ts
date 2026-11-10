// The root package.json is the single source of truth for the version (bumped by scripts/release.mjs).
import { version } from "../../../package.json";

/** Application version shown in the dashboard, the update check and the in-game info command. */
export const CRAFTPANEL_VERSION: string = version;
export const CRAFTPANEL_REPO = "vctrchappot/CraftPanel";
export const CRAFTPANEL_REPO_URL = `https://github.com/${CRAFTPANEL_REPO}`;
/** The project's landing page; the user documentation lives under `/docs/`. */
export const CRAFTPANEL_SITE_URL = "https://craftpanel.vctr.site/";

/** Original author, credited in the dashboard, the README and the in-game info card. */
export const CRAFTPANEL_AUTHOR = {
  name: "Victor",
  handle: "vctrchappot",
  github: "https://github.com/vctrchappot",
  website: "https://www.vctr.site",
} as const;

/**
 * Locale of the user interface. The dashboard is English-only, so dates and relative times are formatted in this
 * locale instead of the browser's, which would mix languages ("vor 5 Minuten" next to English labels).
 */
export const APP_LOCALE = "en";
