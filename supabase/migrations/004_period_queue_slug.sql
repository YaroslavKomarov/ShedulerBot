-- Add queue_slug to sch_periods
-- Allows multiple periods to share a single task queue.
-- Two periods with the same queue_slug will pull tasks from the same pool.
-- By default queue_slug = slug (no change in behavior for existing periods).

ALTER TABLE sch_periods ADD COLUMN queue_slug text;
UPDATE sch_periods SET queue_slug = slug WHERE queue_slug IS NULL;
ALTER TABLE sch_periods ALTER COLUMN queue_slug SET NOT NULL;
