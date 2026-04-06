# Implementation Plan: Шаг 9 — CI/CD (GitHub Actions)

Branch: master
Created: 2026-04-07

## Settings
- Testing: yes (already exists — 80 tests passing)
- Logging: standard
- Docs: no

## Current State

- `npm test` — ✅ 80 tests passing across 11 files (vitest)
- `typecheck` / `lint` scripts — ❌ missing from package.json
- ESLint — ❌ not installed (not in devDependencies)
- `.github/workflows/ci.yml` — ❌ doesn't exist
- Branch protection — requires manual setup in GitHub UI

## Commit Plan

- **Commit 1** (after tasks 1–4): `chore: add ESLint, typecheck scripts, and GitHub Actions CI workflow`

## Tasks

### Phase 1: Scripts & Tooling

- [ ] Task 1: Add `typecheck` and `lint` scripts to `package.json`
  - Add `"typecheck": "tsc --noEmit"` script
  - Add `"lint": "eslint src"` script
  - Files: `package.json`

- [ ] Task 2: Install and configure ESLint for TypeScript
  - Install devDependencies: `eslint`, `typescript-eslint`
  - Create `eslint.config.js` (flat config, ESLint v9+)
  - Configure: TypeScript parser + recommended rules, ignore `dist/` and `node_modules/`
  - Run `npm run lint` — fix any errors found in `src/`
  - LOGGING: no special logging needed (build-time tool)
  - Files: `eslint.config.js`, `package.json`

### Phase 2: CI Workflow

- [ ] Task 3: Create `.github/workflows/ci.yml`
  - Trigger: `pull_request` targeting `main` branch
  - Job: `ci` running on `ubuntu-latest`
  - Steps:
    1. `actions/checkout@v4`
    2. `actions/setup-node@v4` — Node.js 20, npm cache
    3. `npm ci` — clean install
    4. `npm run typecheck` — TypeScript type check
    5. `npm run lint` — ESLint
    6. `npm test` — vitest run
  - Files: `.github/workflows/ci.yml`

### Phase 3: Verification & Protection

- [ ] Task 4: Verify all CI steps pass locally
  - Run `npm run typecheck` → must exit 0
  - Run `npm run lint` → must exit 0 (fix any lint errors)
  - Run `npm test` → must exit 0 (80 tests passing)

- [ ] Task 5: Configure branch protection on `main` in GitHub (manual)
  - Go to: GitHub repo → Settings → Branches → Add branch protection rule
  - Branch name pattern: `main`
  - Enable: "Require status checks to pass before merging"
  - Add status check: `ci` (the job name from ci.yml)
  - Enable: "Require branches to be up to date before merging"
  - NOTE: This is a manual step in GitHub UI — no code changes required
