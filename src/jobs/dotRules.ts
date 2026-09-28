// DoT 覆蓋率與提早續上：每個職業要追蹤的 DoT，移植自 xivanalysis（MIT）dawntrail 分支（commit b240252）
// 核心的 core/modules/DoTs 與各職業模組（sam/Higanbana、drg/Debuffs、ast/Combust、whm、sch、sge、brd、blm 的 DoTs；
// rpr/DeathsDesign 只有覆蓋率）。效果 ID 與持續時間取自 xivanalysis 的 src/data/STATUSES（遊戲狀態 ID）。

export interface DotRule {
  /** 同一職業內唯一 */
  key: string
  /** 遊戲狀態 ID（FFLogs 的效果 ID 為 1,000,000＋此值）；同一列的多個效果（單體／範圍版）合併計算 */
  statusIds: number[]
  /** 持續時間（毫秒），計算提早續上時覆蓋掉的剩餘時間 */
  durationMs: number
  /** 覆蓋率目標（%）：xivanalysis checklist 的 target */
  uptimeTarget: number
  /**
   * 提早續上的建議門檻（每分鐘覆蓋掉的毫秒數，達到才提）：xivanalysis 的 TieredSuggestion（低／中／高）。
   * 沒有時不檢查提早續上（例如奪魂者的死亡烙印只看覆蓋率）
   */
  clipTiers?: { low: number; medium: number; high: number }
  /** xivanalysis 模組 */
  source: string
}

// 治療與多數職業的預設門檻（ms／分）
const HEALER_TIERS = { low: 6000, medium: 9000, high: 12000 }

/** 以 FFLogs subType 為鍵；沒有列出的職業沒有 DoT 檢查 */
export const DOT_RULES: Record<string, DotRule[]> = {
  Samurai: [{ key: 'higanbana', statusIds: [1228], durationMs: 60000, uptimeTarget: 90, clipTiers: { low: 1000, medium: 30000, high: 60000 }, source: 'sam/Higanbana' }],
  Dragoon: [{ key: 'chaotic-spring', statusIds: [2719], durationMs: 24000, uptimeTarget: 90, clipTiers: { low: 5000, medium: 10000, high: 15000 }, source: 'drg/Debuffs' }],
  WhiteMage: [{ key: 'dia', statusIds: [1871], durationMs: 30000, uptimeTarget: 95, clipTiers: HEALER_TIERS, source: 'whm/DoTs' }],
  Scholar: [{ key: 'biolysis', statusIds: [1895], durationMs: 30000, uptimeTarget: 95, clipTiers: HEALER_TIERS, source: 'sch/DoTs' }],
  Astrologian: [{ key: 'combust', statusIds: [1881], durationMs: 30000, uptimeTarget: 95, clipTiers: HEALER_TIERS, source: 'ast/Combust' }],
  // 均衡注藥III／均衡失衡（範圍）：覆蓋率相加
  Sage: [{ key: 'eukrasian-dosis', statusIds: [2616, 3897], durationMs: 30000, uptimeTarget: 95, clipTiers: HEALER_TIERS, source: 'sge/DoTs' }],
  // 烈毒咬箭、狂風蝕箭各一列；xivanalysis 以兩者提早續上的平均值判斷，設計上每 2 分鐘約提早 15 秒，門檻較寬
  Bard: [
    { key: 'caustic-bite', statusIds: [1200], durationMs: 45000, uptimeTarget: 95, clipTiers: { low: 10000, medium: 15000, high: 20000 }, source: 'brd/DoTs' },
    { key: 'stormbite', statusIds: [1201], durationMs: 45000, uptimeTarget: 95, clipTiers: { low: 10000, medium: 15000, high: 20000 }, source: 'brd/DoTs' },
  ],
  // 高階雷電（30 秒）／高階中雷電（範圍，24 秒）：覆蓋率相加；兩者互換不算提早續上（不同效果）
  BlackMage: [{ key: 'high-thunder', statusIds: [3871, 3872], durationMs: 30000, uptimeTarget: 95, clipTiers: HEALER_TIERS, source: 'blm/DoTs' }],
  // 死亡烙印：增傷減益，只看覆蓋率
  Reaper: [{ key: 'deaths-design', statusIds: [2586], durationMs: 30000, uptimeTarget: 95, source: 'rpr/DeathsDesign' }],
}

/** 各效果的持續時間（高階中雷電 24 秒，其餘同規則） */
export const DOT_DURATION_OVERRIDES: Record<number, number> = { 3872: 24000 }

/** FFLogs 的效果 ID */
export const fflogsStatusId = (statusId: number) => 1_000_000 + statusId
