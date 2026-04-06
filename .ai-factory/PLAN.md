# Implementation Plan: Шаг 10 — Деплой на Railway

Branch: master
Created: 2026-04-07

## Settings
- Testing: no (infrastructure tasks)
- Logging: standard
- Docs: no

## Commit Plan

- **Commit 1** (after tasks 1–2): `chore: add health check endpoint and railway.json`
- **Commit 2** (after task 3): `chore: add Dockerfile for Railway deployment`

## Tasks

### Phase 1: App Readiness

- [x] Task 1: Add `/health` endpoint to Express app
  - Add `GET /health` route that returns `{ status: 'ok', uptime: process.uptime() }` with HTTP 200
  - Railway uses this to verify the service is alive before routing traffic
  - Add directly to `src/index.ts` before other routes
  - LOGGING: Log `[app] Health check endpoint registered` at INFO on startup
  - Files: `src/index.ts`

- [x] Task 2: Create `railway.json`
  - Explicit Railway build + start config (avoids auto-detection surprises)
  - Content:
    ```json
    {
      "$schema": "https://railway.app/railway.schema.json",
      "build": {
        "builder": "NIXPACKS",
        "buildCommand": "npm ci && npm run build"
      },
      "deploy": {
        "startCommand": "npm start",
        "healthcheckPath": "/health",
        "healthcheckTimeout": 30,
        "restartPolicyType": "ON_FAILURE",
        "restartPolicyMaxRetries": 3
      }
    }
    ```
  - LOGGING: no special logging (build-time config)
  - Files: `railway.json`

- [x] Task 3: Create `Dockerfile` (Railway fallback / explicit control)
  - Multi-stage build: `build` stage installs devDeps + compiles TypeScript; `prod` stage installs only production deps
  - Base image: `node:22-alpine`
  - Build stage: `COPY . .` → `npm ci` → `npm run build`
  - Prod stage: `COPY --from=build /app/dist ./dist` + `COPY package*.json .` → `npm ci --omit=dev`
  - `CMD ["node", "dist/index.js"]`
  - Add `.dockerignore` excluding `node_modules`, `dist`, `.env`, `.github`
  - LOGGING: no special logging (build-time)
  - Files: `Dockerfile`, `.dockerignore`

### Phase 2: Railway Project Setup (Manual Steps)

- [ ] Task 4: Create Railway project and connect GitHub repo (manual)
  - Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
  - Select the `ShedulerBot` repo
  - Railway auto-detects `railway.json` and uses it
  - NOTE: This is a manual step in Railway dashboard — no code changes required

- [ ] Task 5: Set environment variables in Railway dashboard (manual)
  - Go to: Railway project → Service → Variables tab
  - Set all required env vars:
    ```
    NODE_ENV=production
    TELEGRAM_BOT_TOKEN=<your token>
    OPENROUTER_API_KEY=<your key>
    SUPABASE_URL=<your url>
    SUPABASE_SERVICE_ROLE_KEY=<your key>
    GOOGLE_CLIENT_ID=<your id>
    GOOGLE_CLIENT_SECRET=<your secret>
    GOOGLE_REDIRECT_URI=https://<railway-domain>/auth/google/callback
    LOG_LEVEL=info
    ```
  - Railway injects `PORT` automatically — do NOT set it manually
  - NOTE: This is a manual step in Railway dashboard

- [ ] Task 6: Configure Railway public domain and set WEBHOOK_URL (manual)
  - Go to: Railway project → Service → Settings → Networking
  - Generate a Railway public domain (e.g. `shedulerbot-production.up.railway.app`)
  - Add env variable: `WEBHOOK_URL=https://<railway-domain>`
  - Redeploy the service so the bot registers the webhook
  - Verify webhook is set: `GET https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
  - NOTE: This is a manual step in Railway dashboard

### Phase 3: Verification

- [ ] Task 7: Verify deployment health and logs
  - Check Railway deploy logs: no fatal errors at startup
  - Hit `GET https://<railway-domain>/health` → expect `{ status: 'ok' }`
  - Send `/start` to the bot in Telegram → expect onboarding response
  - Check Railway metrics: memory and CPU are stable
  - LOGGING: Review structured logs in Railway log viewer — confirm LOG_LEVEL=info is working
