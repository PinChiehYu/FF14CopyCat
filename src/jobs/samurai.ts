import type { JobModule } from './index'
import { jobName } from './names'

// 7.x 武士的 GCD。技能 ID 不連續，逐一列出；未列出的（必殺劍系列、明鏡止水、意氣衝天、
// 天眼通、黙想、葉隱、殘心、職能技能、藥水）皆為 oGCD。天眼通是減傷，分類見下方。
// 已被取代的舊技能（Hakaze、Fuga、Tenka Goken 等）一併列入，以支援較低等級的日誌。
const GCDS = new Set([
  7477, // Hakaze
  36963, // Gyofu
  7478, // Jinpu
  7479, // Shifu
  7480, // Yukikaze
  7481, // Gekko
  7482, // Kasha
  7483, // Fuga
  25780, // Fuko
  7484, // Mangetsu
  7485, // Oka
  7486, // Enpi
  7487, // Midare Setsugekka
  7488, // Tenka Goken
  7489, // Higanbana
  36965, // Tendo Goken
  36966, // Tendo Setsugekka
  16483, // Tsubame-gaeshi
  16485, // Kaeshi: Goken
  16486, // Kaeshi: Setsugekka
  36967, // Tendo Kaeshi Goken
  36968, // Tendo Kaeshi Setsugekka
  25781, // Ogi Namikiri
  25782, // Kaeshi: Namikiri
])

// 減傷：重要的學習課題
const MITIGATION = new Set([
  7498, // Third Eye
  36962, // Tengentsu
])

export const samurai: JobModule = {
  subType: 'Samurai',
  name: jobName('Samurai'),
  isGcd: (id) => GCDS.has(id),
  mitigation: MITIGATION,
}
