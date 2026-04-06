# AGENTS.md

> Project map for AI agents. Keep this file up-to-date as the project evolves.

## Project Overview

ShedulerBot is a Telegram-based day planning service that manages activity periods, task queues, and daily workflows through an LLM-driven conversational interface. It is one module in a larger planning system, sharing a Supabase instance with other modules (tables prefixed `sch_`).

## Tech Stack

- **Language:** TypeScript
- **Runtime:** Node.js (long-running process)
- **Telegram:** Grammy + @grammyjs/conversations
- **Database:** Supabase (shared instance, prefix `sch_`)
- **LLM:** OpenRouter API (fast model for NLU, strong model for generation)
- **Cron:** node-cron (dynamic jobs per user)
- **Calendar:** Google Calendar API (optional OAuth)
- **Deploy:** Railway / Fly.io / VPS

## Project Structure

```
ShedulerBot/
├── src/
│   ├── bot/                  # Grammy bot setup and handlers
│   │   ├── index.ts          # Bot initialization, middleware, start
│   │   ├── commands.ts       # /start, /plan, /tomorrow, /backlog, /settings
│   │   ├── handlers.ts       # Free-text catch-all handler
│   │   └── conversations/    # Grammy FSM conversations
│   │       ├── onboarding.ts # First-run setup dialog
│   │       ├── add-task.ts   # Task addition interview
│   │       └── settings.ts   # Settings change dialog
│   ├── db/
│   │   ├── client.ts         # Supabase client (service role)
│   │   ├── types.ts          # Generated types (npx supabase gen types)
│   │   ├── users.ts          # sch_users queries
│   │   ├── periods.ts        # sch_periods queries
│   │   └── tasks.ts          # sch_tasks queries + priority queue
│   ├── llm/
│   │   ├── client.ts         # OpenRouter client + model aliases
│   │   ├── intent.ts         # Intent detection (fast model)
│   │   ├── parse-task.ts     # Task extraction from free text (fast model)
│   │   ├── interview.ts      # Conversational LLM for onboarding/retro (strong model)
│   │   └── plan.ts           # Day plan message generation (strong model)
│   ├── cron/
│   │   ├── manager.ts        # Register/unregister cron jobs per user
│   │   ├── morning-plan.ts   # Morning plan job
│   │   ├── period-notify.ts  # Pre-start, start, pre-end, end notifications
│   │   └── retrospective.ts  # End-of-day retrospective job
│   ├── calendar/
│   │   ├── auth.ts           # OAuth URL generation
│   │   ├── client.ts         # Calendar client factory per user
│   │   └── sync.ts           # Sync day plan to Google Calendar
│   ├── api/
│   │   └── tasks.ts          # POST /api/tasks — external task intake
│   └── index.ts              # Entry point: Express + bot + cron bootstrap
├── .ai-factory/
│   └── DESCRIPTION.md        # Full project specification
├── .env                      # Environment variables (gitignored)
├── .env.example              # Environment variable template
├── package.json
└── tsconfig.json
```

## Key Entry Points

| File | Purpose |
|------|---------|
| [src/index.ts](src/index.ts) | Main entry — starts Express, bot, and registers cron jobs for all users |
| [src/bot/index.ts](src/bot/index.ts) | Grammy bot initialization and middleware chain |
| [src/bot/handlers.ts](src/bot/handlers.ts) | Free-text intent routing via LLM |
| [src/cron/manager.ts](src/cron/manager.ts) | Dynamic cron job registry per user and timezone |
| [src/db/client.ts](src/db/client.ts) | Supabase client (service role key) |
| [src/llm/client.ts](src/llm/client.ts) | OpenRouter client + MODELS constant |
| [src/api/tasks.ts](src/api/tasks.ts) | External API endpoint for other system modules |

## Domain Model

| Entity | Table | Key Fields |
|--------|-------|-----------|
| User | `sch_users` | telegram_id, timezone, morning_time, end_of_day_time, google tokens |
| Period | `sch_periods` | user_id, slug, start_time, end_time, days_of_week[], order_index |
| Task | `sch_tasks` | user_id, period_slug, title, is_urgent, deadline_date, status, scheduled_date |

**Task priority order:** urgent → deadline (nearest first) → no deadline (FIFO, always displaced)

## AI Context Files

| File | Purpose |
|------|---------|
| AGENTS.md | This file — project structure map |
| [.ai-factory/DESCRIPTION.md](.ai-factory/DESCRIPTION.md) | Full project spec: features, architecture, DB schema, implementation order |

## Available Skills

| Skill | When to use |
|-------|-------------|
| `grammy-patterns` | Grammy bot setup, conversations (FSM), message formatting |
| `openrouter-llm` | LLM calls, intent detection, task parsing, plan generation |
| `supabase-ts` | DB queries, schema, type generation |
| `google-calendar` | OAuth flow, calendar event sync |
