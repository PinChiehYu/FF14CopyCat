import type { Fight } from './types'

/** FFLogs 的零式難度（爬蟲也只收這個難度，worker/src/crawler.ts） */
export const SAVAGE_DIFFICULTY = 101

/**
 * 絕境戰的 FFLogs encounter ID → 繁中服的副本名稱（難度與一般副本同為 100，只能依 ID 判斷）。
 * 7.x 的 FFLogs 把歷代絕境戰放在同一個區域、ID 連號；換資料片時 FFLogs 會給新的 ID，要更新這份清單。
 * 2026-10-26 以實際報告確認：UCoB 1073（Q7FrdqvZV2LwcRxz）、UwU 1074（jqf7kK4TXtPnZ6py）、TEA 1075（Fy2dGATD39H64Nah）、
 * DSR 1076（xCPHfKRndL7tk2gz）、TOP 1077（P2KwrgTR19fG3vQ6）、FRU 1079（WpYFgvtTJ8QHcDR9 #63）。
 * 名稱為遊戲資料 ContentFinderCondition 的繁中名稱（列 280、539、694、788、908、1006，原文「絕」後即有空格）。
 * FFLogs 的戰鬥名稱有時是副本英文名（Futures Rewritten），NPC 名稱查不到，所以絕境戰一律用這裡的名稱。
 */
export const ULTIMATE_ENCOUNTERS: ReadonlyMap<number, string> = new Map([
  [1073, '絕 巴哈姆特殲滅戰'],
  [1074, '絕 究極武器破壞作戰'],
  [1075, '絕 亞歷山大殲滅戰'],
  [1076, '絕 龍詩戰爭'],
  [1077, '絕 歐米茄驗證戰'],
  [1079, '絕 光暗未來殲滅戰'],
])

/** 本站分析的戰鬥：零式與絕境戰（雜兵、新月島、討伐戰、木人等不列入戰鬥選單、也不查繁中名稱） */
export function isSupportedFight(fight: Pick<Fight, 'encounterID' | 'difficulty'>): boolean {
  return fight.encounterID > 0 && (fight.difficulty === SAVAGE_DIFFICULTY || ULTIMATE_ENCOUNTERS.has(fight.encounterID))
}
