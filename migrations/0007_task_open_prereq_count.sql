-- Number of direct prerequisites that are not done yet. Kept up to date by the task and dependency
-- code, it makes "is this task blocked?" a column check instead of a graph walk.
ALTER TABLE tasks ADD COLUMN open_prereq_count int NOT NULL DEFAULT 0 CHECK (open_prereq_count >= 0);
