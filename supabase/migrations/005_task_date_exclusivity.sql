-- scheduled_date and deadline_date are semantically mutually exclusive:
-- scheduled_date pins a task to a specific day; deadline_date allows any day up to a limit.
-- Setting both simultaneously is a contradiction.
ALTER TABLE sch_tasks
  ADD CONSTRAINT sch_tasks_date_exclusivity
  CHECK (NOT (scheduled_date IS NOT NULL AND deadline_date IS NOT NULL));
