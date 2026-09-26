-- 繁中服排名資料庫（D1）。套用：npx wrangler d1 execute ff14-copycat-rankings --remote --file worker/schema.sql

-- 每位繁中服玩家每場擊殺的輸出
CREATE TABLE IF NOT EXISTS parses (
  report TEXT NOT NULL,
  fight INTEGER NOT NULL,
  actor INTEGER NOT NULL,
  encounter INTEGER NOT NULL,
  difficulty INTEGER NOT NULL,
  job TEXT NOT NULL,
  name TEXT NOT NULL,
  server TEXT NOT NULL,
  dps REAL NOT NULL,
  -- 戰鬥在報告中的開始與結束（毫秒，相對於報告開始），供前端抓 Boss 施放比對機制
  fight_start INTEGER NOT NULL,
  fight_end INTEGER NOT NULL,
  -- 報告開始時間（Unix 毫秒）
  report_start INTEGER NOT NULL,
  PRIMARY KEY (report, fight, actor)
);
CREATE INDEX IF NOT EXISTS parses_rank ON parses (encounter, difficulty, job, dps DESC);

-- 已處理過的報告（避免重複計算）
CREATE TABLE IF NOT EXISTS scanned_reports (
  code TEXT PRIMARY KEY,
  scanned_at INTEGER NOT NULL
);

-- 掃描進度（key/value）
CREATE TABLE IF NOT EXISTS crawl_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
