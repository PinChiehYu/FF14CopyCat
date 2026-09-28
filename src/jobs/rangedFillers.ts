// 止損技：近戰與坦克被迫離開 Boss（機制、擊退、遠離）時用來不斷 GCD 的遠程 GCD，威力低，
// 用得多代表離 Boss 太遠或走位不順。技能 ID 以遊戲資料 Action 表查證（名稱、職業、射程 20～25 yalm）。
// 武僧 7.x 沒有遠程 GCD。
export const RANGED_FILLERS: Record<string, number> = {
  /** 騎士 投盾 Shield Lob */
  Paladin: 24,
  /** 戰士 飛斧 Tomahawk */
  Warrior: 46,
  /** 暗黑騎士 傷殘 Unmend */
  DarkKnight: 3624,
  /** 絕槍戰士 雷電彈 Lightning Shot */
  Gunbreaker: 16143,
  /** 龍騎士 貫穿尖 Piercing Talon */
  Dragoon: 90,
  /** 忍者 飛刀 Throwing Dagger */
  Ninja: 2247,
  /** 武士 燕飛 Enpi */
  Samurai: 7486,
  /** 奪魂者 勾刃 Harpe */
  Reaper: 24386,
  /** 毒蛇劍士 飛蛇之牙 Writhing Snap */
  Viper: 34632,
}

const IDS: ReadonlySet<number> = new Set(Object.values(RANGED_FILLERS))

/** 是否為止損技（任何職業；技能 ID 各職業不重複） */
export function isRangedFiller(abilityId: number): boolean {
  return IDS.has(abilityId)
}

/**
 * 有強化效果時是正常打法、不算止損的技能 → 強化效果（FFLogs 效果 ID＝1,000,000＋狀態 ID）：
 * 貫穿尖效果提高（1870，7.1 起後跳後給予）、勾刃效果提高（2845，地獄入境／出境後給予）、燕飛效果提高（1236，夜天後給予）。
 */
const ENHANCED_BY: Record<number, number> = {
  90: 1_001_870,
  24386: 1_002_845,
  7486: 1_001_236,
}

// 強化效果在施放完成時被消耗，移除事件可能比施放時間稍晚
const ENHANCED_TOLERANCE_MS = 500

// 兩邊的止損技相距這麼近（參考時間）視為同一段（同一個機制逼兩人離開 Boss）
export const FILLER_MATCH_MS = 5000

/**
 * 我的每次止損技與參考比較：參考在前後 FILLER_MATCH_MS 內也用了止損技的（多半是機制逼的）與參考沒有用的（可以改善的）。
 * @param mine 我的止損技時間（已換成參考時間）
 * @param ref 參考的止損技時間
 */
export function compareFillers(mine: number[], ref: number[]): { shared: number[]; onlyMine: number[] } {
  const shared: number[] = []
  const onlyMine: number[] = []
  for (const t of mine) (ref.some((r) => Math.abs(r - t) <= FILLER_MATCH_MS) ? shared : onlyMine).push(t)
  return { shared, onlyMine }
}

/**
 * 一側「算止損」的止損技施放時間（該側的戰鬥時間）。不算的：
 * - 開打前與開打後第一個 GCD：戰士飛斧、暗黑傷殘、槍刃雷電彈、奪魂者勾刃等是標準起手（開場拉怪、預讀），不是被迫離開。
 * - 身上有對應的強化效果時（見 ENHANCED_BY）。
 */
export function lossFillerTimes(
  side: { playerCasts: { t: number; abilityId: number }[]; buffs: { statusId: number; start: number; end: number }[] },
  isGcd: (abilityId: number) => boolean,
): Set<number> {
  // 開打後的第一個 GCD（開打前預讀的另外排除）
  const firstGcd = side.playerCasts.find((c) => c.t > 0 && isGcd(c.abilityId))?.t
  const times = new Set<number>()
  for (const c of side.playerCasts) {
    if (!isRangedFiller(c.abilityId)) continue
    if (c.t <= 0 || c.t === firstGcd) continue
    const enhanced = ENHANCED_BY[c.abilityId]
    if (enhanced && side.buffs.some((b) => b.statusId === enhanced && b.start <= c.t && c.t <= b.end + ENHANCED_TOLERANCE_MS)) continue
    times.add(c.t)
  }
  return times
}
