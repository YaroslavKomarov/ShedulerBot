-- Add solo_leveling_token column to sch_users for persistent SoloLeveling connection
ALTER TABLE sch_users
  ADD COLUMN IF NOT EXISTS solo_leveling_token TEXT DEFAULT NULL;
