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
  -- FFLogs 傷害表的 rDPS（繁中服日誌不排名，但仍有計算）；排名依此排序
  -- （正式資料庫的這個欄位是後來以 ALTER TABLE 加上的，沒有 NOT NULL 限制）
  rdps REAL NOT NULL,
  -- 戰鬥在報告中的開始與結束（毫秒，相對於報告開始），供前端抓 Boss 施放比對機制
  fight_start INTEGER NOT NULL,
  fight_end INTEGER NOT NULL,
  -- 報告開始時間（Unix 毫秒）
  report_start INTEGER NOT NULL,
  PRIMARY KEY (report, fight, actor)
);
CREATE INDEX IF NOT EXISTS parses_rdps ON parses (encounter, difficulty, job, rdps DESC);

-- 已處理過的報告（避免重複計算）
CREATE TABLE IF NOT EXISTS scanned_reports (
  code TEXT PRIMARY KEY,
  scanned_at INTEGER NOT NULL,
  -- 最後一次確認報告仍公開的時間（Unix 毫秒）；正式資料庫以 ALTER TABLE scanned_reports ADD COLUMN checked_at INTEGER 加上
  checked_at INTEGER
);

-- 掃描進度（key/value）
CREATE TABLE IF NOT EXISTS crawl_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
