import { Converter } from 'opencc-js/cn2t'

// Boilmaster（XIVAPI v2 相容）鏡像：官方 XIVAPI 只有國際版語言，這個鏡像另有簡中（chs）與繁中（tc）
const XIVAPI_URL = 'https://xivapi-v2.xivcdn.com/api/sheet'
const BATCH_SIZE = 100

// FFLogs 以「0x2000000 + 道具 ID」表示使用道具（例如藥水），HQ 道具再加 1,000,000
const ITEM_OFFSET = 0x2000000
const HQ_OFFSET = 1_000_000
const MAX_ITEM_ID = 2 * HQ_OFFSET

// 簡中轉台灣正體（字元與異體字，不改用詞）
const toTraditional = Converter({ from: 'cn', to: 'tw' })

// FFLogs 以「1,000,000 + 狀態 ID」表示效果（Buff／Debuff）
const STATUS_OFFSET = 1_000_000
const MAX_STATUS_ID = 100_000

type Sheet = 'Action' | 'Item' | 'Status'

/** FFLogs 的技能 ID 轉成要查詢的遊戲資料表與列；不是技能、效果或道具時回傳 null。 */
export function gameRow(id: number): { sheet: Sheet; row: number; hq: boolean } | null {
  if (id > 0 && id < HQ_OFFSET) return { sheet: 'Action', row: id, hq: false }
  const status = id - STATUS_OFFSET
  if (status > 0 && status < MAX_STATUS_ID) return { sheet: 'Status', row: status, hq: false }
  const item = id - ITEM_OFFSET
  if (item > 0 && item < MAX_ITEM_ID) {
    const hq = item >= HQ_OFFSET
    return { sheet: 'Item', row: hq ? item - HQ_OFFSET : item, hq }
  }
  return null
}

/** 名稱是否可用：新版本內容在資料中只有 `_rsv_…` 佔位字串，部分技能沒有名稱。 */
function usable(name: unknown): name is string {
  return typeof name === 'string' && name.trim() !== '' && !name.startsWith('_rsv_')
}

async function fetchNames(sheet: Sheet, rows: number[], language: 'tc' | 'chs'): Promise<Map<number, string>> {
  const names = new Map<number, string>()
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const url = `${XIVAPI_URL}/${sheet}?rows=${batch.join(',')}&fields=Name&language=${language}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`xivapi ${sheet} ${language} ${res.status}`)
    const body = (await res.json()) as { rows: { row_id: number; fields: { Name?: string } }[] }
    for (const row of body.rows) if (usable(row.fields.Name)) names.set(row.row_id, row.fields.Name)
  }
  return names
}

/** 同一張表：優先官方繁中，沒有時查簡中轉繁體。 */
async function sheetNames(sheet: Sheet, rows: number[]): Promise<Map<number, AbilityName>> {
  const result = new Map<number, AbilityName>()
  if (rows.length === 0) return result
  const tc = await fetchNames(sheet, rows, 'tc')
  const missing = rows.filter((row) => !tc.has(row))
  const chs = missing.length > 0 ? await fetchNames(sheet, missing, 'chs') : new Map<number, string>()
  for (const row of rows) {
    const official = tc.get(row)
    if (official) result.set(row, { name: official, source: 'tc' })
    else if (chs.has(row)) result.set(row, { name: toTraditional(chs.get(row)!), source: 'chs' })
  }
  return result
}

export interface AbilityName {
  name: string
  /** tc：官方繁中；chs：簡中轉繁 */
  source: 'tc' | 'chs'
}

/**
 * 查詢技能（Action 表）、效果（Status 表）或道具（Item 表，例如爆發藥）的繁中名稱：優先用官方繁中，
 * 沒有（佔位或空白）時以簡中轉繁體。都沒有的不回傳，由前端沿用 FFLogs 的名稱。
 * @param ids FFLogs 的技能 ID
 */
export async function abilityNames(ids: number[]): Promise<Record<number, AbilityName>> {
  const targets = ids.map((id) => ({ id, target: gameRow(id) })).filter((t) => t.target !== null)
  const rowsOf = (sheet: Sheet) => [...new Set(targets.filter((t) => t.target!.sheet === sheet).map((t) => t.target!.row))]
  const [actions, items, statuses] = await Promise.all([
    sheetNames('Action', rowsOf('Action')),
    sheetNames('Item', rowsOf('Item')),
    sheetNames('Status', rowsOf('Status')),
  ])
  const bySheet = { Action: actions, Item: items, Status: statuses }

  const result: Record<number, AbilityName> = {}
  for (const { id, target } of targets) {
    const found = bySheet[target!.sheet].get(target!.row)
    if (found) result[id] = target!.hq ? { ...found, name: `${found.name}（HQ）` } : found
  }
  return result
}
