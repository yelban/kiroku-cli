-- Repo grounding (A1): validate path facts against the repository itself.
-- root_path: absolute project root recorded by `kiroku start` / MCP gateway.
--   The cwd slug is a lossy projection and reversal is ambiguous, so the
--   sweep only runs for projects with an explicit root.
-- last_swept_commit: git ref of the last grounding sweep, the base for
--   rename detection via `git diff --find-renames`.
-- missing_since: first time a path fact's file was found gone. A fact is only
--   archived after a second confirmation, so branch switches don't kill it.
ALTER TABLE projects ADD COLUMN root_path TEXT;
ALTER TABLE projects ADD COLUMN last_swept_commit TEXT;
ALTER TABLE facts ADD COLUMN missing_since TEXT;
