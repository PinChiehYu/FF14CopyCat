// 對應 worker/src/queries.ts 中查詢所回傳的欄位。

export interface Fight {
  id: number
  name: string
  encounterID: number
  difficulty: number | null
  kill: boolean | null
  /** 相對於報告開始的毫秒數 */
  startTime: number
  endTime: number
  friendlyPlayers: number[] | null
}

export interface Actor {
  id: number
  name: string
  /** 'Player' | 'NPC' | 'Pet' ... */
  type: string
  /** 玩家為職業名稱（例如 'Samurai'） */
  subType: string
  server: string | null
  petOwner: number | null
  gameID: number
}

export interface Ability {
  gameID: number
  /** 顯示名稱：有繁中名稱時為繁中，否則為 FFLogs 的英文名稱 */
  name: string
  /** 換成繁中名稱時保留原本的英文名稱 */
  englishName?: string
  /** 圖示檔名，例如 '003000-003729.png'；網址見 abilityIconUrl() */
  icon: string
  type: string
}

export interface Report {
  code: string
  title: string
  startTime: number
  endTime: number
  fights: Fight[]
  masterData: { actors: Actor[]; abilities: Ability[] }
}

/** FFLogs 事件是鬆散的 JSON，只列出共通欄位。 */
export interface FFLogsEvent {
  timestamp: number
  type: string
  sourceID?: number
  targetID?: number
  abilityGameID?: number
  fight?: number
  [key: string]: unknown
}

export type EventDataType =
  | 'All'
  | 'Buffs'
  | 'Casts'
  | 'CombatantInfo'
  | 'DamageDone'
  | 'DamageTaken'
  | 'Deaths'
  | 'Debuffs'
  | 'Healing'
  | 'Resources'
