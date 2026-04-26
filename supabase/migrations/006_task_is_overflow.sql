-- is_overflow marks tasks that exceed the period's time capacity.
-- Set by the LLM agent when the user confirms adding a task that doesn't fit.
ALTER TABLE sch_tasks ADD COLUMN is_overflow BOOLEAN NOT NULL DEFAULT false;
