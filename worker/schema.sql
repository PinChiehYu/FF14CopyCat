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

-- 預處理：每場（報告＋戰鬥，最多 8 位已收錄玩家共用）的 Boss 施放（src/analysis/castCodec.ts 的編碼，
-- 同一技能 1 秒內只留一次）。搜尋前輩日誌比對機制、前輩平均對齊用（worker/src/timelines.ts）
CREATE TABLE IF NOT EXISTS pull_timelines (
  report TEXT NOT NULL,
  fight INTEGER NOT NULL,
  boss TEXT NOT NULL,
  processed_at INTEGER NOT NULL,
  PRIMARY KEY (report, fight)
);

-- 預處理：已收錄坦克在該場的 MT／ST（承受 Boss 普通攻擊較多者為 MT），前輩平均依此分開選樣本
CREATE TABLE IF NOT EXISTS tank_slots (
  report TEXT NOT NULL,
  fight INTEGER NOT NULL,
  actor INTEGER NOT NULL,
  slot TEXT NOT NULL,
  PRIMARY KEY (report, fight, actor)
);

-- 前輩平均的樣本：每個 Boss×職業（坦克再分 MT／ST）×PR 區間（top 95+／upper 75–94／mid 50–74）最多 30 筆，
-- 由 timelines.ts 的 refreshSamples() 定時選取（穩定選取：仍在區間 ±3 內的保留）
CREATE TABLE IF NOT EXISTS average_samples (
  encounter INTEGER NOT NULL,
  difficulty INTEGER NOT NULL,
  job TEXT NOT NULL,
  slot TEXT NOT NULL,
  tier TEXT NOT NULL,
  report TEXT NOT NULL,
  fight INTEGER NOT NULL,
  actor INTEGER NOT NULL,
  name TEXT NOT NULL,
  server TEXT NOT NULL,
  rdps REAL NOT NULL,
  pr INTEGER NOT NULL,
  -- 繁中服版本（src/jobs/patch.ts）
  patch TEXT NOT NULL,
  selected_at INTEGER NOT NULL,
  PRIMARY KEY (encounter, difficulty, job, slot, tier, report, fight, actor)
);

-- 各區間的候選人數（區間內的擊殺數）與最近一次選樣本的時間
CREATE TABLE IF NOT EXISTS sample_tiers (
  encounter INTEGER NOT NULL,
  difficulty INTEGER NOT NULL,
  job TEXT NOT NULL,
  slot TEXT NOT NULL,
  tier TEXT NOT NULL,
  candidates INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (encounter, difficulty, job, slot, tier)
);

-- 預處理：樣本玩家的全部施放（含 GCD，不含普通攻擊）、自身效果與施加在敵人身上的效果時段、對敵人施加效果的每一次
-- （src/analysis/castCodec.ts 的編碼）。deaths：死亡次數，> 0 的樣本排除（保留這一列當作記號，不再選；內容清空）；
-- -1 為報告已不公開
CREATE TABLE IF NOT EXISTS sample_data (
  report TEXT NOT NULL,
  fight INTEGER NOT NULL,
  actor INTEGER NOT NULL,
  casts TEXT NOT NULL,
  buffs TEXT NOT NULL,
  applications TEXT NOT NULL,
  deaths INTEGER NOT NULL,
  processed_at INTEGER NOT NULL,
  PRIMARY KEY (report, fight, actor)
);
