# Google Calendar Patterns

Patterns for integrating Google Calendar API in this project. Used to sync the daily plan: each activity period → a calendar event with tasks in the description.

## OAuth Setup

### 1. Get credentials (Google Cloud Console)
- Create OAuth 2.0 Client ID (Web application)
- Add redirect URI: `https://your-domain/auth/google/callback`
- Download credentials → set env vars

### 2. OAuth client

```typescript
// src/calendar/auth.ts
import { google } from "googleapis";

export function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!,
  );
}

export function getAuthUrl(telegramId: number): string {
  const oauth2Client = createOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
    state: String(telegramId), // to identify user on callback
    prompt: "consent", // force refresh_token on every auth
  });
}
```

### 3. Handle OAuth callback (Express)

```typescript
// src/routes/auth.ts
import express from "express";
import { createOAuthClient } from "../calendar/auth";
import { supabase } from "../db/client";

const router = express.Router();

router.get("/auth/google/callback", async (req, res) => {
  const { code, state } = req.query as { code: string; state: string };
  const telegramId = parseInt(state);

  const oauth2Client = createOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  await supabase
    .from("sch_users")
    .update({
      google_access_token: tokens.access_token,
      google_refresh_token: tokens.refresh_token ?? undefined,
      google_token_expiry: tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : undefined,
    })
    .eq("telegram_id", telegramId);

  res.send("✅ Google Calendar подключён! Вернись в Telegram.");
});

export default router;
```

## Calendar Client (per user)

```typescript
// src/calendar/client.ts
import { google, calendar_v3 } from "googleapis";
import { createOAuthClient } from "./auth";
import { supabase } from "../db/client";

export async function getCalendarClient(userId: number): Promise<calendar_v3.Calendar | null> {
  const { data: user } = await supabase
    .from("sch_users")
    .select("google_access_token, google_refresh_token, google_token_expiry")
    .eq("id", userId)
    .single();

  if (!user?.google_access_token) return null;

  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials({
    access_token: user.google_access_token,
    refresh_token: user.google_refresh_token ?? undefined,
    expiry_date: user.google_token_expiry
      ? new Date(user.google_token_expiry).getTime()
      : undefined,
  });

  // Auto-refresh: save new tokens when refreshed
  oauth2Client.on("tokens", async (tokens) => {
    await supabase
      .from("sch_users")
      .update({
        google_access_token: tokens.access_token,
        ...(tokens.refresh_token && { google_refresh_token: tokens.refresh_token }),
        ...(tokens.expiry_date && {
          google_token_expiry: new Date(tokens.expiry_date).toISOString(),
        }),
      })
      .eq("id", userId);
  });

  return google.calendar({ version: "v3", auth: oauth2Client });
}
```

## Sync Daily Plan to Calendar

```typescript
// src/calendar/sync.ts
import { getCalendarClient } from "./client";

interface PeriodEvent {
  name: string;
  date: string;      // "2026-04-08"
  startTime: string; // "11:00"
  endTime: string;   // "19:00"
  timezone: string;  // "Europe/Moscow"
  tasks: Array<{ title: string; estimated_minutes?: number; is_urgent: boolean }>;
}

export async function syncPeriodToCalendar(
  userId: number,
  period: PeriodEvent,
  existingEventId?: string // for updates
): Promise<string | null> { // returns event id
  const calendar = await getCalendarClient(userId);
  if (!calendar) return null; // calendar not connected

  const description = period.tasks
    .map(t => `${t.is_urgent ? "⚡ " : "• "}${t.title}${t.estimated_minutes ? ` (~${t.estimated_minutes}м)` : ""}`)
    .join("\n");

  const event = {
    summary: period.name,
    description,
    start: {
      dateTime: `${period.date}T${period.startTime}:00`,
      timeZone: period.timezone,
    },
    end: {
      dateTime: `${period.date}T${period.endTime}:00`,
      timeZone: period.timezone,
    },
  };

  try {
    if (existingEventId) {
      const res = await calendar.events.update({
        calendarId: "primary",
        eventId: existingEventId,
        requestBody: event,
      });
      return res.data.id ?? null;
    } else {
      const res = await calendar.events.insert({
        calendarId: "primary",
        requestBody: event,
      });
      return res.data.id ?? null;
    }
  } catch (err: any) {
    if (err.code === 401) {
      // Token revoked — clear from DB
      await supabase
        .from("sch_users")
        .update({ google_access_token: null, google_refresh_token: null })
        .eq("id", userId);
    }
    console.error("Calendar sync failed:", err.message);
    return null;
  }
}

export async function syncDayPlan(
  userId: number,
  date: string,
  timezone: string,
  periods: PeriodEvent[]
): Promise<void> {
  for (const period of periods) {
    await syncPeriodToCalendar(userId, { ...period, date, timezone });
  }
}
```

## Error Handling

| Error | Cause | Action |
|-------|-------|--------|
| 401 | Token revoked | Clear tokens from DB, notify user to re-auth |
| 403 | Insufficient scope | Re-trigger OAuth with correct scope |
| 404 | Event not found | Create new event instead of updating |
| 429 | Rate limit | Retry with exponential backoff |

Always wrap calendar calls in try/catch — calendar sync is optional and should never crash the bot.

## Key Rules

1. Calendar sync is **optional** — always check if user has connected calendar before syncing
2. Always use `prompt: "consent"` in OAuth URL to ensure `refresh_token` is returned
3. Listen to `oauth2Client.on("tokens")` to persist refreshed tokens
4. If token refresh fails (401) → clear tokens from DB and notify user to reconnect
5. Store `google_token_expiry` — googleapis auto-refreshes before expiry if `refresh_token` is present
6. Calendar events are per-period, not per-task — tasks go in the description

## Dependencies

```json
{
  "googleapis": "^140.x"
}
```
