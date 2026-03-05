DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS rounds;
DROP TABLE IF EXISTS ledger;
DROP TABLE IF EXISTS cuts;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  title TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'VND',
  players_json TEXT NOT NULL,
  is_locked INTEGER NOT NULL DEFAULT 0
);

-- mode: NORMAL | WHITE | KILL
-- victims_json: JSON array of victims for KILL
CREATE TABLE rounds (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  mode TEXT NOT NULL,

  first_player TEXT,
  second_player TEXT,
  third_player TEXT,
  last_player TEXT,
  white_winner TEXT,
  victims_json TEXT,

  note TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE ledger (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  round_id TEXT,
  created_at TEXT NOT NULL,
  player TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Pig cuts (allowed in NORMAL/KILL; disabled in WHITE)
CREATE TABLE cuts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cutter TEXT NOT NULL,
  victim TEXT NOT NULL,
  color TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_rounds_session ON rounds(session_id, idx);
CREATE INDEX idx_ledger_session ON ledger(session_id, created_at);
CREATE INDEX idx_cuts_session ON cuts(session_id);
