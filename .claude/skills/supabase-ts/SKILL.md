# Supabase TypeScript Patterns

Patterns for using Supabase with TypeScript in this project. Uses **service role key** (server-side only). Tables are prefixed `sch_`.

## Client Setup

```typescript
// src/db/client.ts
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types"; // generated types

export const supabase = createClient<Database>(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // server-side only, bypasses RLS
  {
    auth: { persistSession: false },
  }
);
```

## Type Generation

Generate TypeScript types from the live DB schema:

```bash
npx supabase gen types typescript \
  --project-id <your-project-id> \
  --schema public \
  > src/db/types.ts
```

Or via env:
```bash
SUPABASE_ACCESS_TOKEN=<token> npx supabase gen types typescript \
  --linked > src/db/types.ts
```

Re-run after every migration.

## DB Schema (this module)

```sql
-- sch_users
create table sch_users (
  id bigserial primary key,
  telegram_id bigint unique not null,
  timezone text not null default 'UTC',
  morning_time time not null default '09:00',
  end_of_day_time time not null default '22:00',
  google_access_token text,
  google_refresh_token text,
  google_token_expiry timestamptz,
  created_at timestamptz default now()
);

-- sch_periods
create table sch_periods (
  id bigserial primary key,
  user_id bigint references sch_users(id) on delete cascade,
  name text not null,
  slug text not null,
  start_time time not null,
  end_time time not null,
  days_of_week int[] not null, -- 1=Mon, 7=Sun
  order_index int not null default 0,
  unique(user_id, slug)
);

-- sch_tasks
create table sch_tasks (
  id bigserial primary key,
  user_id bigint references sch_users(id) on delete cascade,
  period_slug text not null,
  title text not null,
  description text,
  is_urgent boolean not null default false,
  deadline_date date,
  estimated_minutes int,
  status text not null default 'pending', -- pending|done|cancelled|rescheduled
  scheduled_date date,
  source text not null default 'user', -- user|goal_engine|periodic
  external_id uuid,
  progress_note text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Index for queue queries
create index sch_tasks_queue_idx on sch_tasks(user_id, period_slug, scheduled_date, status);
```

## Query Patterns

### Get user by Telegram ID

```typescript
export async function getUserByTelegramId(telegramId: number) {
  const { data, error } = await supabase
    .from("sch_users")
    .select("*")
    .eq("telegram_id", telegramId)
    .single();

  if (error?.code === "PGRST116") return null; // not found
  if (error) throw error;
  return data;
}
```

### Create user (onboarding)

```typescript
export async function createUser(params: {
  telegramId: number;
  timezone: string;
  morningTime: string;
  endOfDayTime: string;
}) {
  const { data, error } = await supabase
    .from("sch_users")
    .insert({
      telegram_id: params.telegramId,
      timezone: params.timezone,
      morning_time: params.morningTime,
      end_of_day_time: params.endOfDayTime,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}
```

### Get today's task queue for a period (priority order)

```typescript
export async function getTaskQueue(
  userId: number,
  periodSlug: string,
  date: string // ISO date e.g. "2026-04-08"
) {
  const { data, error } = await supabase
    .from("sch_tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("period_slug", periodSlug)
    .eq("scheduled_date", date)
    .eq("status", "pending")
    .order("is_urgent", { ascending: false })      // urgent first
    .order("deadline_date", { ascending: true, nullsFirst: false }) // deadline next
    .order("created_at", { ascending: true });     // FIFO within group

  if (error) throw error;
  return data ?? [];
}
```

### Get backlog (no scheduled date)

```typescript
export async function getBacklog(userId: number, periodSlug?: string) {
  let query = supabase
    .from("sch_tasks")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "pending")
    .is("scheduled_date", null);

  if (periodSlug) {
    query = query.eq("period_slug", periodSlug);
  }

  const { data, error } = await query
    .order("is_urgent", { ascending: false })
    .order("deadline_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}
```

### Upsert task

```typescript
export async function upsertTask(task: {
  userId: number;
  periodSlug: string;
  title: string;
  description?: string;
  isUrgent: boolean;
  estimatedMinutes?: number;
  deadlineDate?: string;
  scheduledDate?: string;
  source?: string;
  externalId?: string;
}) {
  const { data, error } = await supabase
    .from("sch_tasks")
    .insert({
      user_id: task.userId,
      period_slug: task.periodSlug,
      title: task.title,
      description: task.description,
      is_urgent: task.isUrgent,
      estimated_minutes: task.estimatedMinutes,
      deadline_date: task.deadlineDate,
      scheduled_date: task.scheduledDate,
      source: task.source ?? "user",
      external_id: task.externalId,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}
```

### Update task status / fields

```typescript
export async function updateTask(
  taskId: number,
  updates: Partial<{
    status: "pending" | "done" | "cancelled" | "rescheduled";
    scheduledDate: string | null;
    isUrgent: boolean;
    deadlineDate: string | null;
    title: string;
    description: string;
    progressNote: string;
    estimatedMinutes: number;
  }>
) {
  const { error } = await supabase
    .from("sch_tasks")
    .update({
      ...(updates.status && { status: updates.status }),
      ...(updates.scheduledDate !== undefined && { scheduled_date: updates.scheduledDate }),
      ...(updates.isUrgent !== undefined && { is_urgent: updates.isUrgent }),
      ...(updates.deadlineDate !== undefined && { deadline_date: updates.deadlineDate }),
      ...(updates.title && { title: updates.title }),
      ...(updates.description && { description: updates.description }),
      ...(updates.progressNote && { progress_note: updates.progressNote }),
      ...(updates.estimatedMinutes && { estimated_minutes: updates.estimatedMinutes }),
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId);

  if (error) throw error;
}
```

### Get all users with cron data (for job registration on restart)

```typescript
export async function getAllUsersForCron() {
  const { data, error } = await supabase
    .from("sch_users")
    .select("id, telegram_id, timezone, morning_time, end_of_day_time");

  if (error) throw error;
  return data ?? [];
}
```

## Key Rules

1. **Never use the anon key** — always service role key server-side
2. **Never expose Supabase credentials** to the Telegram bot client or any frontend
3. Use **`.single()`** for queries that expect exactly one row; check for `PGRST116` (not found) vs actual errors
4. **Re-generate types** after each schema migration: `npx supabase gen types typescript`
5. All tables use `sch_` prefix — never touch other modules' tables
6. Use **indexes** on `(user_id, period_slug, scheduled_date, status)` for queue queries
7. Google OAuth tokens stored in `sch_users` — treat as sensitive, consider Supabase Vault for production

## Dependencies

```json
{
  "@supabase/supabase-js": "^2.x"
}
```
