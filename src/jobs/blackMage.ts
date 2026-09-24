import type { JobModule } from './index'

// 7.x 黑魔法師的 GCD（攻擊魔法與 Umbral Soul）。技能 ID 不連續，逐一列出，含低等級與已被取代的技能；
// 未列出的（Transpose、Manafont、Ley Lines、Triplecast、Amplifier、Retrace、防禦與移動技能、職能技能、藥水）皆為 oGCD。
// 註：開場預詠唱的 Fire III 在戰鬥開始前就開始詠唱，事件中沒有 begincast，與下一個 GCD 的間隔會只有約 0.6 秒。
const GCDS = new Set([
  141, // Fire
  142, // Blizzard
  144, // Thunder
  147, // Fire II
  152, // Fire III
  153, // Thunder III
  154, // Blizzard III
  156, // Scathe
  159, // Freeze
  162, // Flare
  3576, // Blizzard IV
  3577, // Fire IV
  7420, // Thunder IV
  7422, // Foul
  7447, // Thunder II
  16505, // Despair
  16506, // Umbral Soul
  16507, // Xenoglossy
  25793, // Blizzard II
  25794, // High Fire II
  25795, // High Blizzard II
  25797, // Paradox
  36986, // High Thunder
  36987, // High Thunder II
  36989, // Flare Star
])

// 防禦與移動技能：依攻略與走位使用
const UTILITY = new Set([
  157, // Manaward
  155, // Aetherial Manipulation
  7419, // Between the Lines
  36988, // Retrace（把黑魔紋移到腳下，依走位使用）
])

export const blackMage: JobModule = {
  subType: 'BlackMage',
  name: '黑魔法師',
  isGcd: (id) => GCDS.has(id),
  utility: UTILITY,
}
