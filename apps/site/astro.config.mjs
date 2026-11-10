import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://craftpanel.vctr.site",
  trailingSlash: "ignore",
  integrations: [
    starlight({
      title: "CraftPanel",
      description: "Self-hosted Minecraft server management for your PC, Raspberry Pi or VPS.",
      components: { SiteTitle: "./src/components/SiteTitle.astro" },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/fonts.css", "./src/styles/docs.css"],
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/vctrchappot/CraftPanel" }],
      editLink: { baseUrl: "https://github.com/vctrchappot/CraftPanel/edit/main/apps/site/" },
      lastUpdated: true,
      head: [{ tag: "meta", attrs: { property: "og:image", content: "https://craftpanel.vctr.site/og.png" } }],
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Introduction", slug: "docs" },
            { slug: "docs/getting-started/installation" },
            { slug: "docs/getting-started/first-server" },
            { slug: "docs/getting-started/updating" },
          ],
        },
        {
          label: "Guides",
          items: [
            { slug: "docs/guides/server-software" },
            { slug: "docs/guides/appearance" },
            { slug: "docs/guides/plugins-and-mods" },
            { slug: "docs/guides/worlds-and-backups" },
            { slug: "docs/guides/players" },
            { slug: "docs/guides/automation-and-notifications" },
            { slug: "docs/guides/performance" },
            { slug: "docs/guides/velocity" },
            { slug: "docs/guides/networking" },
          ],
        },
        {
          label: "Administration",
          items: [
            { slug: "docs/administration/users-and-roles" },
            { slug: "docs/administration/remote-access" },
            { slug: "docs/administration/configuration" },
            { slug: "docs/administration/maintenance" },
          ],
        },
        {
          label: "Design system",
          items: [
            { label: "Overview", slug: "docs/design-system" },
            { slug: "docs/design-system/foundations" },
            { slug: "docs/design-system/components" },
            { slug: "docs/design-system/layout-and-data" },
            { slug: "docs/design-system/states-and-accessibility" },
            { slug: "docs/design-system/implementation" },
          ],
        },
        {
          label: "Reference",
          items: [
            { slug: "docs/reference/security" },
            { slug: "docs/reference/architecture" },
            { slug: "docs/reference/troubleshooting" },
            { label: "Changelog", link: "https://github.com/vctrchappot/CraftPanel/blob/main/CHANGELOG.md", attrs: { target: "_blank" } },
          ],
        },
      ],
    }),
  ],
});
