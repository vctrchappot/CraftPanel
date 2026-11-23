<!-- ci:begin (vctrchappot/ci scripts/onboard.sh) -->

## CI

CraftPanel's existing workflow still runs its cross-platform, installer, deployment, browser and site checks. The shared CI onboarding script generated `.github/ci.json` and kept `.github/workflows/ci.yml` in place. A future migration should carry over the existing jobs, including `test:deployment`, `test:e2e` and `test:site`.

Run the project's checks locally before pushing. Push once per goal. Open pull requests as drafts and mark them ready when the work is done.
<!-- ci:end -->
