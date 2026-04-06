# Project: ShedulerBot

## Overview
Scheduler is a day-planning service with a Telegram Bot as its sole interface. It manages a user's activity periods, queued tasks, and daily workflow — sending morning plans, period notifications, and end-of-day retrospectives. It is one module in a larger planning and management system; all modules share a single Supabase instance. This module's tables use the `sch_` prefix.

## Core Features
- **Onboarding** — LLM-driven conversational setup of user profile, activity periods, and Google Calendar connection
- **Morning plan** — Daily scheduled message with tasks distributed across periods, synced to Google Calendar
- **Period notifications** — Pre-start preview, start notification, pre-end reminder, end check-in (4 messages per period)
- **Task management** — Free-text task input with LLM parsing, priority queue (urgent → deadline → no-deadline), inline progress updates
- **Retrospective** — End-of-day cron: review completed/missed tasks, reschedule, address backlog items without dates
- **External API** — `POST /api/tasks` endpoint for receiving tasks from other system modules (e.g. SoloLeveling)

## Tech Stack
- **Language:** TypeScript
- **Runtime:** Node.js (long-running process — not Vercel)
- **Telegram:** Grammy (framework with conversation plugin for FSM dialogs)
- **Database:** Supabase (shared instance, tables prefixed `sch_`)
- **LLM:** OpenRouter API — lightweight model for NLU/parsing, strong model for plan generation and interviews
- **Cron:** node-cron (dynamic jobs per user, running in user's timezone)
- **Calendar:** Google Calendar API (optional per user, OAuth flow)
- **Deploy:** Railway / Fly.io / VPS

## Architecture Notes
- All cron jobs are registered dynamically per user at onboarding (and re-registered on service restart)
- Activity periods are day-of-week aware; no period overlap allowed
- Task priority order: urgent → has deadline (nearest first) → no deadline/urgency (FIFO, always displaced)
- Tasks without deadline/urgency are highlighted in retrospective to force a decision
- LLM receives structured DB context + user message; returns structured actions (JSON function calls or structured output)
- Google Calendar sync: each period → calendar block event with task list in description
- Multi-module DB: this service only touches `sch_*` tables; never reads other modules' tables

## Database Tables (prefix: `sch_`)
- `sch_users` — Telegram ID, timezone, morning notification time, end-of-day time, Google Calendar tokens
- `sch_periods` — user_id, name, slug, start_time, end_time, days_of_week[], order_index
- `sch_tasks` — user_id, period_slug, title, description, is_urgent, deadline_date, estimated_minutes, status, scheduled_date, source, progress_note, created_at

## Non-Functional Requirements
- **Logging:** Structured logs with LOG_LEVEL env var
- **Error handling:** All LLM calls wrapped with fallback; cron errors logged without crashing service
- **Security:** Telegram webhook validation; Supabase service role key server-side only; Google OAuth tokens stored encrypted or via Supabase Vault
- **Timezone:** All cron scheduling respects per-user timezone

## Environment Variables
```
TELEGRAM_BOT_TOKEN=
OPENROUTER_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
```

## Implementation Order
1. Foundation — project init, DB schema, Supabase client, bot bootstrap
2. Onboarding — LLM dialog, profile + periods creation, cron registration
3. Task management — LLM parsing, CRUD, priority queue
4. Morning plan + notifications — plan generation, period cron jobs, Google Calendar sync
5. In-period task management — mark done, update progress, show queue
6. Retrospective — end-of-day cron, rescheduling flow
7. External API — `POST /api/tasks` endpoint
