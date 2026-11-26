# GitHub Setup Documentation

This document outlines the GitHub repository structure, branch management, and workflow processes for the Specimen Sandbox project.

## Repository Configuration

- **Repository URL**: [github.com:TheScottyB/playing-in-the-sandbox-staring-at-flowers](https://github.com/TheScottyB/playing-in-the-sandbox-staring-at-flowers)
- **Authentication**: SSH protocol with GitHub CLI integration
- **Primary Maintainer**: TheScottyB (scottybe@tbdstud.io)

## Branch Structure

The repository maintains a single active remote branch:

- **`main`** - Primary development & GitHub Pages source branch
  - All feature development, bug fixes, daily flower generation commits (`docs/daily/`), and documentation updates target this branch
  - GitHub Pages serves static documentation (`docs/index.html`, `docs/privacy.html`, `docs/terms.html`) and daily flower CDN assets (`docs/daily/`) directly from `/docs` on `main` (there is no `gh-pages` branch on `origin`)
  - Tracked by `origin/main`

## Current Workflow Status

### GitHub Actions

Two automated GitHub Actions workflows are active under `.github/workflows/`:

1. **`.github/workflows/ci.yml`** (`CI`): Runs on `push` and `pull_request` to `main`; executes `pnpm typecheck`, `pnpm lint`, `pnpm db:smoke`, and `node --test tests/unit/*.test.mjs`.
2. **`.github/workflows/generate-daily.yml`** (`Generate Daily Flowers`): Scheduled daily at `11:00 UTC` (`0 11 * * *`) plus manual `workflow_dispatch`; runs `node scripts/generate-daily.mjs` with `GEMINI_API_KEY` and commits/pushes updated `docs/daily/` assets to `main`.

### Commit History Pattern

The repository follows a well-organized development pattern with consistent commit message conventions using the [Conventional Commits](https://www.conventionalcommits.org/) format:

- **`feat:`** - New feature additions
  - Example: "feat: add animated cards feature"
  - Example: "feat: add flower gallery with flip card animations"

- **`docs:`** - Documentation updates
  - Example: "docs: update README with project structure and GitHub Pages info"
  - Example: "docs: add comprehensive iOS Developer Mode guide"

- **`build:`** - Build process or external dependency changes
  - Example: "build: optimize build profiles for development workflow"

- **`chore:`** - Routine maintenance tasks
  - Example: "chore: update .gitignore to exclude build artifacts and credentials"

## Repository Activity

### Main Branch Activity

The `main` branch shows active development with recent additions including:
- Feature implementations (animated cards, flower gallery, image caching)
- Documentation updates
- Build system optimizations

### GitHub Pages Integration

GitHub Pages is configured to serve from the `docs/` folder on the `main` branch (`https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/`), hosting:
- `docs/privacy.html`, `docs/terms.html`, and `docs/index.html`
- Daily generated botanical images and sidecar JSON under `docs/daily/` (note: consider offloading `docs/daily/` per the Maintenance Runbook below to prevent ongoing `.git` pack growth)

## Recommended Next Steps

### Workflow & Pipeline Improvements

1. **Daily CDN Offload**: Move `docs/daily/` writes off `main` (see Security & Repo Maintenance Runbook below) to stop daily pack growth.
2. **Automated E2E & iOS Build Verification**: Extend `.github/workflows/ci.yml` (which currently runs `pnpm typecheck`, `pnpm lint`, `pnpm db:smoke`, and `node --test tests/unit/*.test.mjs`) to run `pnpm test:e2e` (macOS/self-hosted runner) and optional EAS/Xcode build checks.

### Branch Protection Rules

Implement branch protection rules for the `main` branch:

1. Require pull request reviews before merging
2. Require status checks (`CI`) to pass before merging
3. Require branches to be up to date before merging
4. Enforce linear history to maintain clean commit logs

### Automated PR Reviews

Consider enabling Dependabot for dependency updates alongside Biome linting (`pnpm lint`) and TypeScript (`pnpm typecheck`).

## Workflow Model

The repository follows a standard GitHub Flow model:

1. Create feature branches from `main`
2. Develop features in isolation
3. Submit pull requests back to `main`
4. Review code and discuss changes
5. Deploy from `main` when ready

Additionally, the repository utilizes GitHub Pages integration for documentation hosting, serving static files from the `docs/` directory on `main`.

## Security & Repo Maintenance Runbook

### 1. Mandatory Rotation of App Store Connect API Key `XT32ZS8GHR`

Historical commits on `origin/main` (`f3a07c7`, `79f8219`, and `6271691` on `2026-05-23`) temporarily tracked `.env` before deleting it from `HEAD`. Although the `.p8` private key bytes were never committed to git, `.env` exposed `APP_STORE_CONNECT_APP_ID`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, and `APP_STORE_CONNECT_PRIVATE_KEY_PATH` (matching `credentials/ios/AuthKey_XT32ZS8GHR.p8`). **Key `XT32ZS8GHR` must be rotated and revoked.**

**Rotation procedure:**
1. Confirm `.gitignore` blocks `credentials/` and `.env*` (already enforced on `main`).
2. In **App Store Connect -> Users and Access -> Integrations -> App Store Connect API**, generate a new API key and download its `.p8` file to `credentials/ios/AuthKey_<NEW_KEY_ID>.p8`.
3. Update `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, and `APP_STORE_CONNECT_PRIVATE_KEY_PATH` in local `.env`, `.env.local`, EAS secrets, and `eas-app-store-kit` environment variables.
4. Verify authentication with `scripts/manage-subscriptions.mjs` / `eas submit`.
5. **Revoke** key `XT32ZS8GHR` in App Store Connect and delete `credentials/ios/AuthKey_XT32ZS8GHR.p8` locally.

### 2. Coordinated Maintenance-Window `git filter-repo` & Daily CDN Offload (3.72 GiB `.git` Purge)

The `.git` pack currently totals ~3.72 GiB (`docs/daily/` ~2.03 GB across 8,995 blobs from daily PNG->JPG commit/delete churn, plus `shared/design-assets/` ~1.28 GB from commit `89c5d02`). Removing `shared/design-assets/` and legacy WebP images under `docs/daily/` from `HEAD` shrinks working checkouts immediately, but **reclaiming `.git` history requires offloading daily CDN writes off `main` first** (otherwise daily cron commits will re-bloat `.git`).

**Step A — Offload Daily CDN Assets off `main` (choose one before rewriting history):**
- **Option 1 (Recommended — Cloudflare R2 / S3 CDN):** Update `.github/workflows/generate-daily.yml` to upload `docs/daily/` artifacts directly to an R2/S3 bucket (`wrangler r2 object put` / `aws s3 sync`) instead of committing to `main`, and point `PAGES_BASE_URL` in `lib/dailyFlower.ts` to the CDN URL. Keep lightweight HTML (`docs/index.html`, `docs/privacy.html`, `docs/terms.html`) on GitHub Pages.
- **Option 2 (Zero external infra — Orphan `gh-pages` snapshot):** Update `.github/workflows/generate-daily.yml` to publish rolling daily assets to an orphan `gh-pages` branch (`force_orphan: true` via `peaceiris/actions-gh-pages`, backed by cache/artifact state) and switch GitHub Pages source to `gh-pages`, removing `docs/daily/` from `main`.

**Step B — Execute `git filter-repo` during a Coordinated Maintenance Window:**
1. Pause/disable `.github/workflows/generate-daily.yml` schedule and notify all collaborators.
2. Create an off-repo mirror backup:
   ```bash
   git clone --mirror git@github.com:TheScottyB/playing-in-the-sandbox-staring-at-flowers.git ../flowers-backup.git
   ```
3. On a fresh clone (required by `git-filter-repo`, installed at `/opt/homebrew/bin/git-filter-repo`), strip `.env`, `shared/design-assets/`, and `docs/daily/` (once offloaded):
   ```bash
   git filter-repo \
     --path .env --invert-paths \
     --path shared/design-assets --invert-paths \
     --path docs/daily --invert-paths
   ```
   *(Optionally also strip superseded binaries under `app_store_assets/screenshots` and `store/apple` to reclaim ~150 MB more.)*
4. Verify `git count-objects -vH` and `git log --all --stat -- '.env*' 'shared/design-assets' 'docs/daily'` return empty.
5. Force-push rewritten history during the maintenance window:
   ```bash
   git push --force-with-lease origin main
   ```
6. Re-clone local working copies (do not merge old clones into rewritten history) and re-enable the updated daily CDN workflow.

## Maintaining This Setup

### Commit Convention Enforcement

To enforce consistent commit messages, consider using:

```bash
# Install commitlint
pnpm add -D @commitlint/cli @commitlint/config-conventional

# Create commitlint config file
echo "module.exports = {extends: ['@commitlint/config-conventional']}" > commitlint.config.js

# Set up Husky for pre-commit hooks
pnpm add -D husky
pnpm exec husky install
pnpm exec husky add .husky/commit-msg 'pnpm exec commitlint --edit $1'
```

### Regular Workflow Review

Schedule quarterly reviews of the GitHub workflow to:
- Assess effectiveness of current processes
- Identify potential automation improvements
- Update documentation with new best practices
- Train team members on GitHub workflow procedures

---

*Last updated: November 26, 2026*

