# Versioning and releases

The authoritative policy for CraftPanel's version numbers, changelog and releases. Developers and coding agents follow it for every change; `scripts/release.mjs` and `.github/workflows/release.yml` enforce the mechanical parts.

**In short:** one product version (Semantic Versioning) in the root `package.json`; changes collect under "Unreleased" in `CHANGELOG.md`; a release is a deliberate, owner-approved `node scripts/release.mjs bump X.Y.Z && git push --follow-tags`, published by GitHub Actions only after CI passed on exactly that commit. Merging to `main` is not releasing.

## 1. What is versioned

| Thing | Identifier | Source of truth | Changes when |
| --- | --- | --- | --- |
| **CraftPanel (the product)** | SemVer `X.Y.Z`, release candidates `X.Y.Z-rc.N` | `version` in the root `package.json` | Only through `node scripts/release.mjs bump` |
| Workspace manifests (`apps/*`, `packages/*`) | Mirror of the product version | Written by `bump`; never edited by hand | With the product version (`release.mjs check` fails if they differ) |
| Git tag / GitHub release | `vX.Y.Z` (annotated), release titled `CraftPanel vX.Y.Z` | Created by `bump`, published by `release.yml` | Once per version, never moved or reused |
| Release archive | `craftpanel-vX.Y.Z.tar.gz` + `release.json` (`version`, `commit`, `builtAt`) | `release.mjs pack` | Per release |
| Runtime protocol | Integer `RUNTIME_PROTOCOL` (`packages/server-runtime/src/protocol.ts`), `protocol` in `runtime-manifest.json` | That constant | When dashboard ↔ runtime messages change incompatibly. Needs a runtime restart with maintenance approval (allowed in a minor release, see 3.2) |
| Installer recovery contract | `recoveryProtocol` in `release.json` | `release.mjs pack` | When the installers' snapshot/rollback contract changes |
| Application-backup format | Integer `APP_BACKUP_FORMAT` (`apps/api/src/app-backup-format.ts`) | That constant | When the archive layout changes; newer versions keep importing every older format of the same major |
| Database schema | Ordered Drizzle migrations (`packages/database/drizzle/NNNN_*.sql`) | `pnpm db:generate` | With a schema change; forward-only, applied automatically at start |
| `/craftpanel` info plugin | Own SemVer in `plugins/craftpanel-info/resources/plugin.yml` (1.0.0 → 1.1.0 so far) | That file | When the plugin's behaviour changes; independent of the product version (the jar ships inside the product) |
| Website and user docs (`apps/site`) | Not versioned; Vercel deploys `main` continuously | – | Any merge to `main`. The site shows the latest *stable* product release |
| Builds and deployments | Git commit SHA (`commit` in `release.json`); Vercel deployment IDs | Git / Vercel | Every build; never part of a version number |

Not versioned at all: workspace packages (all `private`, never published), internal TypeScript APIs, log line formats (except `doctor --json`), the design system.

Display: the dashboard, the update check, `/api/system` and the in-game card read `CRAFTPANEL_VERSION` (`packages/shared/src/meta.ts`, from the root `package.json`). The website reads the mirror in `apps/site/package.json`. A checkout of `main` reports the last released version even when it contains unreleased changes (see 9, open points).

## 2. Strategy

**Semantic Versioning 2.0.0, one version for the whole product, a stable channel plus optional release candidates.** Reasons:

- CraftPanel is installed by people on their own machines and updated in place by `install.sh`, `install.ps1` or the dashboard's update button. They need to know whether an update is routine or needs attention; SemVer's major/minor/patch says exactly that, and the update check, the installers and the website already compare versions as SemVer.
- Dashboard, API, runtime, installers and migrations ship together in one archive and are tested together. Versioning them separately would add numbers nobody installs separately. Contracts *between* those parts that can drift (runtime protocol, backup format, recovery contract) have their own integer versions above.
- Calendar versioning would hide breaking changes, and continuous releases would push every merge onto people's servers. CraftPanel has release-sized milestones (the roadmap phases), so releases follow them.

## 3. Choosing the increment

### 3.1 The compatibility promise (what "breaking" means here)

From 1.0.0 on, within one major version:

1. **Updating keeps working without manual steps.** Every 1.x install (release package via `install.sh`/`install.ps1`, dashboard update) updates in place by running the installer again or clicking Update. A confirmation in the dashboard (such as the maintenance approval for a runtime restart) is allowed; editing files, running commands, re-installing or re-creating anything is not.
2. **Data stays usable.** The data directory, database (migrations run automatically), server folders, worlds, backups and schedules keep working. Server backups and application backups made by any earlier 1.x restore and import.
3. **Settings keep their meaning.** `CRAFTPANEL_*` variables, the settings file and dashboard settings keep working; a renamed variable keeps its old name as an alias until the next major.
4. **Documented interfaces stay compatible.** HTTP endpoints and WebSocket messages named in the changelog or docs (`API: …` lines), and the CLI (`import-backup`, `doctor --json`), are not removed, renamed or changed in meaning. Adding endpoints, fields, messages or options is compatible; clients must ignore what they don't know.
5. **Access doesn't silently change.** A user keeps the effective access their role and per-server roles gave them, except where a security fix requires otherwise (documented under Security).
6. **Supported platforms stay supported**: Linux x64/ARM64 with systemd, Windows x64, and the server software CraftPanel offers (Vanilla, Paper, Purpur, Fabric, NeoForge, Velocity). Minecraft versions follow upstream: when Mojang or a project stops serving a version, that is not a CraftPanel breaking change.

Source checkouts (`git clone`, `update.sh`/`update.cmd`, `pnpm start`) follow `main` and the requirements in the README; raising the Node.js version for them is announced under "Upgrading" but doesn't need a major version. The release installers bring their own Node.js when the system's is too old.

Not covered by the promise: the dashboard's look and layout, wording, defaults for *new* servers, internal packages, the runtime protocol (it always ships with its dashboard), log formats, downgrades (a database migrated by a newer version is not supported by an older one; the installer's rollback restores its own snapshot instead).

### 3.2 Rules

| Increment | When | CraftPanel examples |
| --- | --- | --- |
| **MAJOR** `X.0.0` | Anything that breaks a promise in 3.1, or removes something deprecated | Dropping Windows task installs for SCM-only; removing `GET /api/servers/:id/metrics` or renaming its fields; refusing application backups of format 1; requiring a manual migration step; dropping Velocity; removing `CRAFTPANEL_PUBLIC_URL` without an alias |
| **MINOR** `x.Y.0` | New user-visible capability or interface, compatible behaviour change, deprecation, or anything existing installs must accept with a confirmation | Stored performance history with new 24 h/7 d/30 d ranges; Activity → Tasks and `GET /api/jobs`; a new server software; per-server isolation needing a runtime restart with maintenance approval (1.1.0); additive migrations; UI redesigns; new settings or variables; a new default for new servers; raising the release installers' Node.js version; a deprecation notice |
| **PATCH** `x.y.Z` | Only fixes to behaviour of released versions: bugs, regressions, security fixes without new features, performance fixes, installer fixes, dependency updates that fix something | Windows installer avoiding the GitHub API rate limit (PR #6); a chart that shows a wrong unit; a migration that repairs bad data; a dependency security update |
| **No release** | Changes that don't change the shipped product | Website-only changes, `docs/` (STATUS, ROADMAP, contributor docs), tests and `scripts/real-tests`, CI workflows, refactoring without behaviour change, dev tooling |

Mixed changes: the release takes the **highest** increment among its unreleased entries (any Added or Changed → minor; any breaking → major). Fixes to features that are still unreleased are not separate changes: they amend the feature's Unreleased entry.

Security fixes: released as a patch on the latest line as soon as they are verified. If closing a hole must break a promise in 3.1, it may ship in a minor or patch anyway, with the break explained under **Security** and **Upgrading**.

Deprecation: announce under **Deprecated** in a minor release with the replacement; it keeps working until the next major, which lists it under **Removed** and **Upgrading**.

Experimental features: ship off by default or clearly marked ("experimental" in the UI and changelog). They are exempt from 3.1 until a release declares them stable. No separate version or channel.

Contract versions (section 1): bump `RUNTIME_PROTOCOL`, `APP_BACKUP_FORMAT` or `recoveryProtocol` when their contract changes, in the same change, and mention a required runtime restart under **Upgrading**. A higher contract version alone never forces a major; breaking 3.1 does.

## 4. Channels and maturity

- **Stable** (since 1.0.0, 2026-11-09): every `vX.Y.Z` GitHub release. `releases/latest`, the one-line installers, the dashboard's update check and the website only ever see stable releases.
- **Release candidate** `vX.Y.Z-rc.N` (optional, not used yet): a GitHub *pre-release*, installable only on purpose (`install.sh --version X.Y.Z-rc.N`, `CRAFTPANEL_INSTALL_VERSION`). Use one when a release changes installers, the runtime service, isolation or migrations and needs a try on real hardware (Raspberry Pi, a VPS, a Windows host) before everyone gets it. An RC takes its notes from "Unreleased" and leaves them there; the final `bump X.Y.Z` turns them into the release section. Promote with `bump X.Y.Z` once the RC was verified and nothing but fixes for it landed.
- **Development**: `main` and source checkouts. Not a release, no version identifier of its own.
- **Maintenance**: only the newest minor line gets patches. An older line gets a patch only for a security or data-loss fix when the fix can't wait for the next minor (release branch, see 6.4). No long-term-support lines.

Alpha, beta and early-access channels are not used: CraftPanel is past 1.0, and a release candidate covers the one case where wider testing before stable is needed. A major version gets at least one release candidate.

## 5. When to release

**Model: milestone-based, with patches on demand.**

| Event | Effect on versions |
| --- | --- |
| Local work, commits, pull requests | None. Add the changelog entry in the same change (section 7) |
| Merge to `main` | None. The change is *merged*, not released; the website (docs included) deploys at once |
| A roadmap step done and verified (STATUS.md ✅ or 🧪 with the gaps listed) | Candidate for a **minor** release; bundle steps that belong together (e.g. the two steps of "Persistent monitoring and recoverable jobs") |
| A regression, data-loss or security fix for the latest release, merged and verified | **Patch** release promptly, on its own; don't wait for features |
| `bump` + `git push --follow-tags` with the owner's go-ahead | The change is *released*: the workflow publishes once CI passed |
| An install updates | The change is *deployed* on that machine; CraftPanel has no deployment of its own |
| Public announcement (r/admincraft, r/selfhosted) | Separate from releasing; only for stable minor or major releases, decided by the owner |

Bundle: a minor release should give users something whole (a finished roadmap step, not half a feature). Don't release individual commits, and don't release several times a day except for a fix of a release made the same day. Release soon after a step is done rather than letting "Unreleased" grow for weeks: the 156 commits between 1.0.0 and 1.1.0 made one large, hard-to-verify release.

Ready to release when all hold:

- `main` is green: the latest CI run on `main` finished successfully (not cancelled), and nothing else is being pushed.
- "Unreleased" describes every user-visible change and its increment matches section 3.
- STATUS.md is honest about what was verified; nothing in the release is known to be broken. Known gaps are written down there.
- Changes to installers, the runtime service, isolation, migrations or backup formats were exercised for real (the scenarios in `scripts/real-tests/`, in WSL or Windows Sandbox as CLAUDE.md describes) or have their gaps stated.
- Anything needing a manual step or approval has an **Upgrading** note.
- The owner agreed to the version number and to publishing.

## 6. Release lifecycle

Steps marked **owner** need the owner's explicit approval for this specific release. Coding agents prepare everything else, but never run `bump` with a push, push a `v*` tag, edit or delete a GitHub release, or announce anything on their own.

1. **Accumulate.** Every user-visible change adds its entry under "Unreleased" in the same commit or pull request.
2. **Assess scope.** Read "Unreleased" top to bottom, apply section 3, check every entry is accurate for what is on `main` now (merge duplicates, drop entries for reverted work).
3. **Choose the version** (**owner**): the highest increment needed; `release.mjs bump` refuses a version that isn't newer.
4. **Release notes.** Add an **Upgrading** section first if anything needs a step or approval. Preview with `node scripts/release.mjs notes unreleased`.
5. **Validate locally** on an up-to-date `main`:
   ```bash
   pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build
   node scripts/release.mjs check
   ```
   plus the real-server scenarios for the areas the release touches (section 5).
6. **Compatibility.** Confirm against 3.1: updating from the previous release (CI's "Linux upgrade from the previous release" job does this on Linux), old application backups still import, documented endpoints unchanged.
7. **Migrations.** Generated with `pnpm db:generate` and committed with their change; never edit a migration that is in a release.
8. **Wait for CI on `main`** to finish green: `gh run list --branch main --workflow ci.yml --limit 1`.
9. **Bump** (**owner**): on `main`, equal to `origin/main`:
   ```bash
   node scripts/release.mjs bump X.Y.Z      # dates the changelog (UTC), sets every manifest, commits "Release vX.Y.Z", tags vX.Y.Z
   git push --follow-tags                   # owner's go-ahead required: this starts publication
   ```
   Don't push anything else to `main` until the release workflow has finished: a newer push cancels the CI run the release waits for.
10. **Publish (automatic).** `release.yml`: `release.mjs check --tag` (tag matches the version, changelog section, newer than earlier releases of its line, commit on `main` or `release/x.y.x`), waits for the CI run of the tagged commit to pass, then typecheck, tests, build, `pack`, a smoke test of the archive, and `gh release create` with the changelog section and install instructions. Tags with `-rc.N` become pre-releases.
11. **Verify the published release:**
    ```bash
    gh release view vX.Y.Z      # assets: craftpanel-vX.Y.Z.tar.gz, install.sh, install.ps1, release.json, SHA256SUMS
    curl -fsSLI -o /dev/null -w '%{url_effective}\n' https://github.com/vctrchappot/CraftPanel/releases/latest   # …/tag/vX.Y.Z (stable only)
    ```
    and on a test install: Settings → Security & about offers the update and shows the notes. Then update "Current state" in `docs/ROADMAP.md` and, if useful, STATUS.md.
12. **Rollback and hotfix**: section 6.3 and 6.4.

### 6.1 Naming

- Tags `vX.Y.Z` / `vX.Y.Z-rc.N`, annotated, created by `bump` only. Other tag namespaces (e.g. `archive/…`) are never `v`-prefixed.
- Release commit `Release vX.Y.Z`; GitHub release title `CraftPanel vX.Y.Z`; changelog heading `## X.Y.Z – YYYY-MM-DD` (en dash, release date in UTC).

### 6.2 Branches

`main` is the only long-lived branch and the release branch. Features land through pull requests or direct pushes as CLAUDE.md describes. `release/X.Y.x` branches exist only for patches of an older line (6.4) and are created from the tag when needed; CI runs on them.

### 6.3 A release that fails or is broken

- **Workflow failed before "Publish"** (nothing published): if CI failed for a flaky reason, re-run CI on the commit, then re-run the release workflow. If the commit is really broken, fix it on `main` and release the next patch version; the unpublished tag stays (tags are never moved or deleted once pushed), and the next release's notes say that X.Y.Z was not published.
- **Published, but broken** (**owner**): mark it as a pre-release with a warning at the top of its notes (`gh release edit vX.Y.Z --prerelease --notes-file …`). That takes it out of `releases/latest`, so installers and update checks offer the previous stable release again, while machines that already updated keep running. Then publish a fixed patch as soon as possible. Never delete a published release or its tag: installers and links refer to them. Downgrading an installed machine is not supported (migrations are forward-only); the installers roll back on their own only when the new version doesn't start.

### 6.4 Hotfix on an older line

Only when `main` already carries unreleased changes that are not ready:

```bash
git switch -c release/1.1.x v1.1.0          # once per line
# fix (cherry-pick from main where possible), entry under "Unreleased", push the branch: CI runs on release/**
node scripts/release.mjs bump 1.1.1          # on release/1.1.x, equal to origin/release/1.1.x, CI green
git push --follow-tags                       # owner's go-ahead
```

Then merge `release/1.1.x` into `main` right away: `main`'s changelog must contain the `1.1.1` section (CI's `release.mjs check` fails until it does), and the fix's entry leaves "Unreleased" on `main`. Keep `main`'s own version.

## 7. Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com): "## Unreleased" first, then releases newest first. It is shipped in every archive, shown as "What's new" in the dashboard after an update and as the update's release notes, and becomes the GitHub release text, so it is written for people who run CraftPanel.

- **Needs an entry:** every change to the shipped product a user, admin or API client could notice: features, behaviour changes, fixes of released behaviour, security fixes, deprecations, removals, new or changed API endpoints, settings or variables, new requirements.
- **No entry:** website-only and documentation changes, tests, CI, refactoring, dev tooling, fixes of unreleased features (edit their entry instead). Website changes are not in the release archive and deploy on their own; 1.1.0 still listed them, later releases don't.
- **When:** in the same commit or pull request as the change, under "Unreleased". `release.mjs bump` moves "Unreleased" into the release section; never write a dated section by hand.
- **Categories**, in this order, only those that apply: **Upgrading** (steps or approvals, CraftPanel's addition: first, so nobody misses it), **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**, **Security**.
- **Style:** what changes for the user, in full sentences, in English; name the place in the dashboard (Settings → Backups); end with `API: …` for interface changes. Breaking changes and migrations say what happens and what to do, under **Upgrading**.
- **Released sections are frozen**: they are already in archives and GitHub releases. Corrections go into the next release's notes. (Known blemish kept as published: one entry in 1.1.0 → Fixed is listed twice.)
- Pre-1.0 history (0.1.0–0.3.0) stays as written; before 1.0, minor versions could change behaviour.

## 8. Automated checks

| Check | Where | What it catches |
| --- | --- | --- |
| `node scripts/release.mjs check` | Locally; CI "Changes" job on every push and pull request | Version syntax (`X.Y.Z`/`X.Y.Z-rc.N`), manifests that differ from the root version, changelog structure ("Unreleased" first, `## X.Y.Z – YYYY-MM-DD`, newest first, no duplicates, dates in order), no section for the current version, a stable tag without a section, a current version without its tag (unpushed tag or hand-edited version) |
| `release.mjs bump` | When releasing | Dirty tree, existing tag, version not newer, branch other than `main`/`release/x.y.x`, commit not pushed, empty "Unreleased", any `check` problem |
| `release.mjs check --tag` | `release.yml` | Tag ≠ version, version not newer than its line (regression, duplicate), RC for an already released version, commit not on `main`/`release/x.y.x` |
| CI run of the tagged commit | `release.yml` | Publishing code that hasn't passed the full CI (the bump touches every manifest, so all areas run) |
| Typecheck, tests, build, pack, archive smoke test | `release.yml` | A broken archive |
| `gh release create` | `release.yml` | Publishing the same version twice (it refuses an existing release) |
| Tag pushes | GitHub permissions | Only maintainers with write access can push `v*` tags; agents don't push them without the owner's go-ahead |

Tests: `scripts/release.test.ts` (versions, `check`, `bump` refusals), `apps/api/test/updates.test.ts` (update-check ordering), `apps/site/test/github.test.ts` (the website shows stable releases only).

## 9. History and open points

Verified from tags, GitHub releases, the changelog and CI runs (2026-11-27):

| Version | Tag commit date | GitHub release | Notes |
| --- | --- | --- | --- |
| 0.1.0 | 2026-11-07 | 2026-11-09 10:44 | Published two minutes before 0.2.0; the release workflow was already part of this tag, why its release came two days later isn't recorded |
| 0.2.0 | 2026-11-09 | 2026-11-09 10:46 | Release packages and installers |
| 0.2.1 | 2026-11-09 | 2026-11-09 11:00 | Patch, 3 commits |
| 0.3.0 | 2026-11-09 | 2026-11-09 12:59 | Runtime service; needed a manual upgrade step (allowed before 1.0) |
| 1.0.0 | 2026-11-09 | 2026-11-09 13:30 | Declared stable 31 minutes after 0.3.0, with fixes only |
| 1.1.0 | 2026-11-23 | 2026-11-23 08:56 | 156 commits; additive features, runtime restart with approval, compatible |

Assessment: increments matched their content (0.x minors changed behaviour as allowed; 1.0.0 was a stability declaration; 1.1.0 was additive). Every release went through `bump` and the tag workflow, versions are consistent across manifests, and no development build was published as a release.

Inconsistencies found and how they are handled now:

- Four releases within three hours on 2026-11-09, and 1.0.0 without any time on the field after the 0.3.0 runtime change. Now: bundle by milestone (section 5); a major gets a release candidate.
- v1.1.0 was published before CI had finished for its code: the `main` run for the commit before the release commit was cancelled by the release push, and the release commit's own run passed only alongside publication. Now `release.yml` waits for the tagged commit's CI run.
- The release workflow only compared the tag with `package.json`. Now `check --tag` also checks ordering, the changelog and the branch.
- Thirteen manifests carry the version; CLAUDE.md said it "lives only in the root `package.json`". They are mirrors written by `bump`, and the website reads its mirror. Now `check` fails if any of them differs.
- 1.1.0's notes include many website-only entries, while the website isn't part of the archive. From now on they stay out (section 7).
- The changelog's header named `scripts/release.mjs <version>`; the command is `bump <version>`. Fixed.
- The update check compared pre-release identifiers as text (`rc.10` before `rc.2`), and the website would have advertised a release candidate on `main`. Both fixed.
- Tag `archive/wip-runtime-separation` is an archive marker, not a release; the release workflow only reacts to `v*`.

Open points (owner decisions):

- **Development builds look like releases.** A checkout of `main` reports the last release's version (e.g. 1.1.0) while running unreleased code, and its update check sees no newer release. Option: show the commit (`1.1.0+abc1234`) for non-release builds.
- **Release candidates are untested end to end**: `install.sh --version X.Y.Z-rc.N` and the Windows installer's local-folder lookup (stable archive names only) have never been run with an RC.
- **Raising Node.js for source checkouts** is treated as minor with an Upgrading note (3.1); decide whether checkouts should get the full promise.
- **Branch protection** for `main` and tag protection for `v*` are GitHub settings outside the repository; consider tag protection so only the owner can push `v*`.
