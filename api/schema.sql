-- Bio 305 API — D1 schema
-- profiles: whole-blob LWW sync (server-clock-ordered, per Plate's proven pattern)
CREATE TABLE IF NOT EXISTS profiles (
  account     TEXT PRIMARY KEY,   -- his passcode-derived account id (e.g. "christian")
  blob        TEXT NOT NULL,      -- the full Store state JSON
  updated_at  INTEGER NOT NULL    -- server timestamp (ms) at write — the LWW key
);

-- grade_jobs: deep-grade queue. Frontend enqueues; local claude -p relay drains; frontend polls.
CREATE TABLE IF NOT EXISTS grade_jobs (
  id            TEXT PRIMARY KEY,
  account       TEXT NOT NULL,
  card_id       TEXT,
  question      TEXT NOT NULL,
  model_answer  TEXT,
  student_answer TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | done | error
  verdict       TEXT,             -- correct | partial | incorrect
  score         REAL,             -- 0..1
  note          TEXT,             -- one-line LLM rationale
  created_at    INTEGER NOT NULL,
  graded_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON grade_jobs(status, created_at);
