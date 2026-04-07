-- Chat history for conversational context
-- Stores last N messages per user; application trims to 10 records on write

CREATE TABLE sch_chat_history (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES sch_users(id) ON DELETE CASCADE,
  role       text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sch_chat_history_user_created_idx ON sch_chat_history (user_id, created_at DESC);
