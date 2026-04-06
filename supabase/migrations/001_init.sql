-- ShedulerBot DB schema
-- Tables use sch_ prefix; this module never touches other modules' tables.

-- sch_users: Telegram user profile with scheduling config and optional Google Calendar tokens
CREATE TABLE sch_users (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id          bigint      UNIQUE NOT NULL,
  timezone             text        NOT NULL DEFAULT 'UTC',
  morning_time         time        NOT NULL DEFAULT '08:00',
  end_of_day_time      time        NOT NULL DEFAULT '21:00',
  google_access_token  text,
  google_refresh_token text,
  google_token_expiry  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sch_users_telegram_id_idx ON sch_users (telegram_id);

-- sch_periods: User-defined activity periods (e.g. Morning, Deep Work, Evening)
-- days_of_week: array of ISO weekday numbers (1=Mon ... 7=Sun)
-- No period overlap is enforced at the application layer
CREATE TABLE sch_periods (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES sch_users (id) ON DELETE CASCADE,
  name         text        NOT NULL,
  slug         text        NOT NULL,
  start_time   time        NOT NULL,
  end_time     time        NOT NULL,
  days_of_week int[]       NOT NULL,
  order_index  int         NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

CREATE INDEX sch_periods_user_id_idx ON sch_periods (user_id);

-- sch_tasks: Task queue with priority ordering: urgent → deadline → created_at (FIFO)
-- status: pending | done | cancelled
-- source: user | external | generated
-- external_id: stable ID from the originating module (e.g. SoloLeveling task ID)
CREATE TABLE sch_tasks (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES sch_users (id) ON DELETE CASCADE,
  period_slug       text,
  title             text        NOT NULL,
  description       text,
  is_urgent         boolean     NOT NULL DEFAULT false,
  deadline_date     date,
  estimated_minutes int,
  status            text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'done', 'cancelled')),
  scheduled_date    date,
  source            text        NOT NULL DEFAULT 'user'
                                CHECK (source IN ('user', 'external', 'generated')),
  external_id       text,
  progress_note     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sch_tasks_user_date_idx  ON sch_tasks (user_id, scheduled_date);
CREATE INDEX sch_tasks_user_status_idx ON sch_tasks (user_id, status);

-- Prevent duplicate external tasks (idempotent POST /api/tasks)
CREATE UNIQUE INDEX sch_tasks_external_id_idx
  ON sch_tasks (user_id, external_id)
  WHERE external_id IS NOT NULL;
