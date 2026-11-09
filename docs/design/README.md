# Design system

One set of tokens and one type family for the dashboard (`apps/web`), the website and the user docs (`apps/site`). The public reference with swatches and examples is [craftpanel.vctr.site/docs/reference/design-system/](https://craftpanel.vctr.site/docs/reference/design-system/); this page is for changing it.

## Where things live

| File | What |
| --- | --- |
| `packages/ui/src/styles/tokens.css` | Palette, semantic colours (light default, dark under `.dark` / `[data-theme="dark"]`), font stacks, radii. The single source. |
| `packages/ui/src/styles/fonts.css` | `@font-face` for the website and the OG image, pointing at the official `geist` package in `packages/ui/node_modules`. |
| `apps/web/src/app/layout.tsx` | The dashboard loads the same fonts through the package's own `geist/font/*` (next/font: preloading, fallback metrics). |
| `apps/web/src/app/globals.css` | Maps the tokens to the dashboard's Tailwind theme (`bg-background`, `text-brand-text`, `font-serif`, `rounded-lg`, …). |
| `apps/site/src/styles/landing.css` | The landing page's names for the tokens (top of the file). |
| `apps/site/src/styles/docs.css` | Starlight's `--sl-*` variables on the tokens. |
| `apps/site/scripts/og.html` | Social preview image; regenerate with `node apps/site/scripts/og.mjs`. |
| `apps/web/src/components/logo.tsx`, `apps/site/src/components/Mark.astro` | The mark, inline so its top face follows the theme. |
| `apps/*/public/favicon.*`, `apple-touch-icon.png`, `apps/site/src/assets/mark-on-*.svg` | Files from the brand package (v1.0), unchanged. |

Fonts are self-hosted from the `geist` npm package (Vercel, SIL Open Font License). Never load them, or anything else, from a CDN: the dashboard promises no third-party requests. To update Geist, bump `geist` in `packages/ui` and `apps/web` together.

## Type

| Family | Weight | Used for |
| --- | --- | --- |
| **Geist** (Sans, variable) | 400 body, 500 labels and headlines (dashboard and website), 600 only for the wordmark and small emphasis | Everything by default. |
| **Geist Mono** (variable) | 400–500 | Console, logs, commands, paths, ports, versions, metrics, section numbers and labels, comparison table. |
| **Geist Serif** | 400 only | Human voice: the "What's new" dialog title and the developer quote on the website. Nothing else. |

Keep weights low: nothing above 600. Large Geist at 700+ with tight tracking looks blunt; precision comes from size and spacing, not weight. Serif ships a single weight and `font-synthesis-weight: none` is set globally, so give it `font-normal` instead of inheriting a bold one. The wordmark is Geist Sans 600 next to the mark (the brand package's Archivo wordmark is not used).

## Colour

Warm greys ("deepslate" dark, "sandstone" light) carry the UI. Three colour roles, never mixed:

- **Brand: Signal green** `#5bbf4a`, the prompt colour of the logo (`--cp-brand`, `--cp-brand-text`, `--cp-brand-button`). "Update available", setup, website calls to action, terminal prompts. Not for buttons or links inside the dashboard.
- **Accent: gold** (`--cp-accent`). Focus rings, selection, active controls, links. The dashboard's interaction colour.
- **Status** (`--cp-success` emerald, `--cp-warning` copper, `--cp-danger` redstone). Only for state: running, needs attention, failed. Never decoration.

Contrast (WCAG 2.x, on background / surface):

| Token | Light | Dark |
| --- | --- | --- |
| `fg` | #1c1b18 · 15.3 / 16.5 | #ece8df · 14.8 / 13.1 |
| `fg-muted` | #5f5a52 · 6.1 / 6.5 | #a8a197 · 7.1 / 6.3 |
| `brand-text` | #2f6b25 · 5.7 / 6.2 | #7ccf6a · 9.5 / 8.4 |
| `accent` | #8a5a00 · 5.3 / 5.7 | #e8b03a · 9.2 / 8.2 |
| `success` | #177245 · 5.3 / 5.7 | #4cc38a · 8.2 / 7.2 |
| `warning` | #a8480c · 5.2 / 5.6 | #f0883e · 7.1 / 6.3 |
| `danger` | #b8321f · 5.3 / 5.7 | #ef5a48 · 5.4 / 4.8 |

Buttons: brand button 7.6 (light, white text) / 7.3 (dark, dark text); accent fill 5.9 / 9.2. Any new pair must reach 4.5:1 for text and 3:1 for UI boundaries; recheck after changing a hex value.

## Shape and spacing

- Radii: `--cp-radius-sm` 2 px (badges, inputs' inner parts), `--cp-radius` 4 px (buttons, inputs), `--cp-radius-lg` 6 px (cards, panels, dialogs). Tailwind's `rounded-xl/2xl` map to 6 px, so nothing gets rounder.
- Spacing follows Tailwind's 4 px scale. Prefer sections with dividers over nested cards.
- The website may use hard offset shadows and block textures; the dashboard stays flat (borders, no shadows except overlays).

## The mark

An isometric block with a console prompt, from the brand package. Its colours are its own and don't follow the tokens, except the top face: `#C6CBC5` on light surfaces, `#E6E8E3` on dark ones. Never colour the top face green, never distort or decorate it. The isometric Minecraft scenes on the website are the world, not the mark; their grass stays grass-block green.

## Rules of thumb

- Use semantic tokens (`--cp-fg`, `bg-surface`, `text-brand-text`), not palette steps, in components.
- A new colour starts in `tokens.css` with a light and a dark value, then gets a name in `globals.css` / `landing.css` / `docs.css` as needed, then a row in the contrast table here and on the website page.
- After visual changes, refresh the website screenshots (`node scripts/site-screenshots.mjs`, see `CLAUDE.md`) and the OG image.
