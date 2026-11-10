# Design system

One set of tokens and one type family for the dashboard (`apps/web`), the website and the user docs (`apps/site`). The public reference with swatches and examples is [craftpanel.vctr.site/docs/reference/design-system/](https://craftpanel.vctr.site/docs/reference/design-system/); this page is for changing it.

## Where things live

| File | What |
| --- | --- |
| `packages/ui/src/styles/tokens.css` | Palette, semantic colours (light default, dark under `.dark` / `[data-theme="dark"]`), font stacks, radii. The single source. |
| `packages/ui/src/styles/fonts.css`, `packages/ui/src/styles/fonts/` | `@font-face` for the website and the OG image: Inter, Mona Sans and Mona Sans Mono as committed variable WOFF2 files (with their licences), Geist Serif from the official `geist` package in `packages/ui/node_modules`. |
| `apps/web/src/app/layout.tsx` | The dashboard loads the same files through `next/font/local` and Geist Serif through `geist/font/serif` (next/font: preloading, fallback metrics). |
| `apps/web/src/app/globals.css` | Maps the tokens to the dashboard's Tailwind theme (`bg-background`, `text-brand-text`, `font-serif`, `rounded-lg`, …). |
| `apps/site/src/styles/landing.css` | The landing page's names for the tokens (top of the file). |
| `apps/site/src/styles/docs.css` | Starlight's `--sl-*` variables on the tokens. |
| `apps/site/scripts/og.html` | Social preview image; regenerate with `node apps/site/scripts/og.mjs`. |
| `apps/web/src/components/logo.tsx`, `apps/site/src/components/Mark.astro` | The mark, inline so its top face follows the theme. |
| `apps/site/src/lib/scenes.ts`, `apps/site/src/components/Iso.astro` | Original, code-drawn isometric hardware and worlds; sharp at any size, no image downloads. |
| `apps/site/src/components/RuntimeDiagram.astro` | Interactive update & runtime showcase: a panel update or rollback leaves the illustrated Minecraft runtime and players online. |
| `apps/*/public/favicon.*`, `apple-touch-icon.png`, `apps/site/src/assets/mark-on-*.svg` | Files from the brand package (v1.0), unchanged. |

All fonts are self-hosted (SIL Open Font License). Never load them, or anything else, from a CDN: the dashboard promises no third-party requests. Inter comes from the official [Inter 4.1 release](https://github.com/rsms/inter/releases/tag/v4.1) (`web/InterVariable.woff2`), Mona Sans and Mona Sans Mono from the official [Mona Sans 2.0.27 webfonts](https://github.com/github/mona-sans/releases/tag/v2.0.27) (`MonaSansVF[opsz,wght].woff2`, `MonaSansMonoVF[wght].woff2`); to update them, replace the files in `packages/ui/src/styles/fonts/` and their licences. To update Geist Serif, bump `geist` in `packages/ui` and `apps/web` together.

## Type

| Family | Weight | Used for |
| --- | --- | --- |
| **Mona Sans** (variable, optical size) | 500 headers, 600 only for the wordmark | Headers and displays (`--cp-font-display`): page, section, card and dialog titles (`h1`–`h3`), hero and `.display` titles, the wordmark. |
| **Inter** (variable, optical size) | 400 body, 500 labels, 600 only for small emphasis | Everything else by default: body text, UI labels, buttons, forms, tables. |
| **Mona Sans Mono** (variable) | 400–500 | Console, logs, commands, paths, ports, versions, metrics, section numbers and labels, comparison table. |
| **Geist Serif** | 400 only | Human voice: the "What's new" dialog title and the project statement on the website. Nothing else. |

Keep weights low: nothing above 600. Headers use **Mona Sans** at 500 with negative tracking; precision comes from size and spacing, not weight. Serif ships a single weight and `font-synthesis-weight: none` is set globally, so give it `font-normal` instead of inheriting a bold one. The wordmark is Mona Sans 600 next to the mark (the brand package's Archivo wordmark is not used).

Sans tracking is negative: `--cp-tracking-body` −0.01 em for Inter body and UI text, `--cp-tracking-heading` −0.02 em for Mona Sans headings, and `--cp-tracking-display` −0.03 em (−0.035 em on the hero H1) for large display headers. Mona Sans already tightens at large sizes through its optical-size axis, so keep its tracking milder than Inter Display's used to be. Mono commands and console output retain normal tracking for legibility.

On the landing page, keep a clear size step between levels so headings do not compete: hero `clamp(48px, 5vw, 72px)`, section headings `clamp(32px, 3.5vw, 48px)`, feature card headings `22px`, body copy `16px` (`line-height: 1.55`), and technical labels `12–13px` Mona Sans Mono.

## Colour

Warm greys ("deepslate" dark, "sandstone" light) carry the UI. Three colour roles, never mixed:

- **Brand: Signal green** `#5bbf4a`, the prompt colour of the logo (`--cp-brand`, `--cp-brand-text`, `--cp-brand-button`). "Update available", setup, website calls to action, terminal prompts. Not for buttons or links inside the dashboard.
- **Accent: neutral** (`--cp-accent`). Dark ink in light mode, light ink in dark mode. Focus rings, selection and active controls; links are underlined. Amber is reserved for state.
- **Status fills, identical in both themes:** Signal `#5bbf4a` running, Amber `#e8b04a` starting, Ember `#ef5a4f` crashed, Ash `#9aa1a8` stopped (`--cp-status-*`). Brand and running share the same green.
- **Status text:** `--cp-success`, `--cp-warning`, `--cp-danger`, `--cp-neutral` use the same colours in dark mode and darker ink steps in light mode for readable text. Use status fills for dots and bars, ink tokens for small text.

Contrast (WCAG 2.x, on background / surface):

| Token | Light | Dark |
| --- | --- | --- |
| `fg` | #1c1b18 · 15.3 / 16.5 | #ece8df · 14.8 / 13.1 |
| `fg-muted` | #5f5a52 · 6.1 / 6.5 | #a8a197 · 7.1 / 6.3 |
| `brand-text`, `success` | #2f6b25 · 5.7 / 6.2 | #5bbf4a · 7.7 / 6.9 |
| `accent` | #1c1b18 · 15.3 / 16.5 | #ece8df · 14.8 / 13.1 |
| `warning` | #8a5a00 · 5.3 / 5.7 | #e8b04a · 9.2 / 8.2 |
| `danger` | #b8321f · 5.3 / 5.7 | #ef5a4f · 5.4 / 4.8 |
| `neutral` | #5c636a · 5.4 / 5.8 | #9aa1a8 · 6.9 / 6.1 |
| `console-muted` on the console | #9a9488 · 5.8 | #9a9488 · 6.4 |

Buttons: brand button 7.6 (light, white text) / 7.3 (dark, dark text). Any new pair must reach 4.5:1 for text and 3:1 for essential UI boundaries; recheck after changing a hex value. Status dots have adjacent text labels; their exact palette fills are not small-text colours on light surfaces.

## Shape and spacing

- Radii: `--cp-radius-sm` 2 px (badges, inputs' inner parts), `--cp-radius` 4 px (buttons, inputs), `--cp-radius-lg` 6 px (cards, panels, dialogs). Tailwind's `rounded-xl/2xl` map to 6 px, so nothing gets rounder.
- Spacing follows Tailwind's 4 px scale. Prefer sections with dividers over nested cards.
- All dividers and underlines are solid. The hero underline is a 6 px Signal bar.
- Hard offset shadows on the website mean active/selected: selected software, hover/focus on interactive cards, open hotspot tooltips. Static terminals, screenshots, panels and the avatar stay flat. The isometric scene's cast shadow is part of its illustration, an intentional exception documented in CSS.
- The dashboard stays flat (borders, no shadows except overlays).
- Landing-page feature displays share a single outer frame with 1 px internal dividers. The live console, unified update & runtime continuity showcase, backup and add-on demos align to that grid; compact features close the frame. On mobile the same frame stacks in reading order.

## Dashboard presentation

- UI locale is `APP_LOCALE` in `packages/shared/src/meta.ts` (currently English). Relative times and dates use it, never the browser's preferred language.
- Activity icons follow event kind: running = Signal, starting = Amber, stopped = Ash, crashed = Ember. Updates and installs are neutral. Failures retain warning/error emphasis.
- Connection addresses list physical LAN first, then VPN and virtual adapters with product labels. Classification uses known adapter names; renamed or unrecognised adapters can remain generic. A private IP range alone does not identify VirtualBox or Tailscale. The access policy still uses IP/CIDR rules independently of these display labels.
- Console output has 16 px inner spacing, including above the first line; live-connection and severity colours use shared status tokens.
- Compact activity feeds stay within the neighbouring content column on desktop, with an internal keyboard-accessible scroll region. On mobile they cap at 320 px. Events arrive newest first and server events refresh the overview immediately; the full activity page remains paginated.

## The mark

An isometric block with a console prompt, from the brand package. Its colours are its own and don't follow the tokens, except the top face: `#C6CBC5` on light surfaces, `#E6E8E3` on dark ones. Never colour the top face green, never distort or decorate it. The isometric Minecraft scenes on the website are the world, not the mark; their grass stays grass-block green.

## Product illustrations

Technical cutaways and isometric scenes explain ownership and process boundaries. Hardware has recognisable details: PCB traces, sockets and mounting pads, PC cooling fans, rack ears and screws. Small shelters, paths and terrain make the world feel inhabited without official Minecraft assets.

The runtime illustration contrasts a reconnecting control panel with uninterrupted game processes. Its restart is a local demonstration; it never sends a command to an actual server. Keep the maintenance limit in the adjacent copy: updating the runtime itself requires a planned stop. The houses represent worlds, not containers or a claim of per-server OS isolation.

**Drawing language.** The technical graphics read like a datasheet: one outer frame, 1 px dividers, a tab on the frame edge, 5 px registration squares in the corners (`.dl-marks`, `.dl-tab` in `landing.css`), mono captions with real values. Two registers carry meaning. Filled voxel scenes are the Minecraft side (worlds, houses, players); outlined isometric drawings (`<Iso outline>`, styled by `.iso-line`) are the CraftPanel side (processes, layers, data). Outlines fill with the surface colour so they hide what is behind them, strokes use `--line-strong`, and only what is active turns `--fg` or Signal green; nothing glows. Outline drawings stand on one 5×5 plate and carry an invisible "ghost" box, so they all render at one scale and baseline.

**Process band** (`components/ProcessBand.astro`, scenes in `processScenes`): seven real steps from install to update inside a frame labelled "runs on your hardware", with the browser and the players outside it. The steps are beads on one continuous line, and each carries an actor tag: `you` (solid) for the three steps the user owns (install, pick, update), outlined `CraftPanel` or `players` for the rest. While the band is on screen the line fills step by step (done steps white, the current one highlighted in Signal green), and a note below says who does what; hovering or focusing a step pins it and shows its note. Below 880 px it becomes a vertical stepper. With reduced motion nothing plays, hover and focus still work.

**Website icons** (two components, no icon font): software icons (`Pixel.astro`, grids in `lib/pixel-icons.ts`) are drawn on a 16×16 grid with a 1 px dark outline, two fills and one highlight row, and are used only at 32 or 48 px (whole-pixel scales). Everything else (`UiIcon.astro`, paths in `lib/ui-icons.ts`) is one colour on a 24×24 grid of 2-unit pixels and is used at 12, 24, 36 or 48 px. Most UI icons are from [pixelarticons](https://github.com/halfmage/pixelarticons) 2.4.2 (MIT, © Gerrit Halfmann; licence in `apps/site/src/assets/pixelarticons-LICENSE.txt`); the seal, cup and mod icons are drawn on the same grid and stroke weight because the set has none.

Scenes move in small loops that show the product working (floating island and rising data packets on the Pi, activity LEDs, smoke, walking players, the dashboard link pulse that stops during an update, a scrolling TPS line). Motion hooks are classes on boxes in `apps/site/src/lib/scenes.ts` (`float`, `packet`, `smoke`, `walker`, `window`, `water`, `led`, `led-act`), styled under "scene motion" in `landing.css`: transforms on a box's `<g>`, colour and opacity on its polygons. `landing.ts` pauses scenes off-screen (`data-paused`) and reveals bento tiles and hardware cards once (`.motion` / `.is-in`).

Use semantic tokens for frames, controls and text in both themes. Materials inside the artwork may keep their own shades. Respect reduced motion, keep labels outside small SVG geometry and retain the same scene on mobile. Avoid glow effects, third-party art and extra illustration libraries.

## Rules of thumb

- Use semantic tokens (`--cp-fg`, `bg-surface`, `text-brand-text`), not palette steps, in components.
- A new colour starts in `tokens.css` with a light and a dark value, then gets a name in `globals.css` / `landing.css` / `docs.css` as needed, then a row in the contrast table here and on the website page.
- A switch between a few options always glides: use `SegmentedControl` (options side by side) or `Tabs` (swaps a panel) from `@craftpanel/ui`, never a hand-made row of `aria-pressed` buttons with a background that jumps. Both share `SlidingIndicator` (`packages/ui/src/segmented.tsx`), which follows whichever item is marked selected (`data-state="active"`, `aria-pressed`, `aria-checked` or `aria-selected`), skips the first placement and honours reduced motion. Anything new that behaves like a switch uses it too.
- After visual changes, refresh the website screenshots (`node scripts/site-screenshots.mjs`, see `CLAUDE.md`) and the OG image.
