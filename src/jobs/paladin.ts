import type { JobModule } from './index'
import { jobName } from './names'

// 7.x 騎士的 GCD。技能 ID 不連續，逐一列出；未列出的（Fight or Flight、Circle of Scorn、Expiacion、
// Intervene、Blade of Honor、Imperator、防禦技、職能技能、藥水）皆為 oGCD。
const GCDS = new Set([
  9, // Fast Blade
  15, // Riot Blade
  21, // Rage of Halone
  3539, // Royal Authority
  7381, // Total Eclipse
  16457, // Prominence
  16460, // Atonement
  36918, // Supplication
  36919, // Sepulchre
  7384, // Holy Spirit
  16458, // Holy Circle
  16459, // Confiteor
  25748, // Blade of Faith
  25749, // Blade of Truth
  25750, // Blade of Valor
  3538, // Goring Blade
  24, // Shield Lob
  3541, // Clemency
])

// 坦姿開關：不需紀錄
const IGNORED = new Set([
  28, // Iron Will
  32065, // Release Iron Will
])

// 減傷：重要的學習課題
const MITIGATION = new Set([
  17, // Sentinel
  36920, // Guardian
  22, // Bulwark
  30, // Hallowed Ground
  3542, // Sheltron
  25746, // Holy Sheltron
  3540, // Divine Veil
  7382, // Intervention
  7385, // Passage of Arms
  27, // Cover
])

const UTILITY = new Set([
  3541, // Clemency
])

export const paladin: JobModule = {
  subType: 'Paladin',
  name: jobName('Paladin'),
  isGcd: (id) => GCDS.has(id),
  ignored: IGNORED,
  mitigation: MITIGATION,
  utility: UTILITY,
}
