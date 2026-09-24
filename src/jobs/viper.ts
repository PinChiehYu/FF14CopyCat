import type { JobModule } from './index'

// 7.x 蝰蛇劍士的技能 ID 連續排列：
// 34606–34633 為 GCD（Steel Fangs … Uncoiled Fury，含 AoE、Reawaken、Generation、Ouroboros、Writhing Snap），
// 34634–34647 為 oGCD（Death Rattle、Twinfang/Twinblood、Legacy、Slither、Serpent's Ire 等）。
// 職能技能（True North、Feint 等）與藥水皆為 oGCD。
const FIRST_GCD = 34606
const LAST_GCD = 34633

export const viper: JobModule = {
  subType: 'Viper',
  name: '蝰蛇劍士',
  isGcd: (id) => id >= FIRST_GCD && id <= LAST_GCD,
}
