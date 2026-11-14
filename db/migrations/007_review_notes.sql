-- Reviewer notes in the editor console (dashboard phase 3). Only adds a column, so it is safe on the live database.
ALTER TABLE tool_candidates ADD COLUMN IF NOT EXISTS review_note text CHECK (review_note IS NULL OR length(review_note) <= 2000);
