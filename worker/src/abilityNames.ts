import { Converter } from 'opencc-js/cn2t'

// Boilmaster（XIVAPI v2 相容）鏡像：官方 XIVAPI 只有國際版語言，這個鏡像另有簡中（chs）與繁中（tc）
const XIVAPI_URL = 'https://xivapi-v2.xivcdn.com/api/sheet/Action'
const BATCH_SIZE = 100

// 簡中轉台灣正體（字元與異體字，不改用詞）
const toTraditional = Converter({ from: 'cn', to: 'tw' })

/** 名稱是否可用：新版本內容在資料中只有 `_rsv_…` 佔位字串，部分技能沒有名稱。 */
function usable(name: unknown): name is string {
  return typeof name === 'string' && name.trim() !== '' && !name.startsWith('_rsv_')
}

async function fetchNames(ids: number[], language: 'tc' | 'chs'): Promise<Map<number, string>> {
  const names = new Map<number, string>()
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE)
    const url = `${XIVAPI_URL}?rows=${batch.join(',')}&fields=Name&language=${language}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`xivapi ${language} ${res.status}`)
    const body = (await res.json()) as { rows: { row_id: number; fields: { Name?: string } }[] }
    for (const row of body.rows) if (usable(row.fields.Name)) names.set(row.row_id, row.fields.Name)
  }
  return names
}

export interface AbilityName {
  name: string
  /** tc：官方繁中；chs：簡中轉繁 */
  source: 'tc' | 'chs'
}

/**
 * 查詢技能的繁中名稱：優先用官方繁中，沒有（佔位或空白）時以簡中轉繁體。
 * 兩者都沒有的技能不回傳，由前端沿用 FFLogs 的名稱。
 */
export async function abilityNames(ids: number[]): Promise<Record<number, AbilityName>> {
  const tc = await fetchNames(ids, 'tc')
  const missing = ids.filter((id) => !tc.has(id))
  const chs = missing.length > 0 ? await fetchNames(missing, 'chs') : new Map<number, string>()

  const result: Record<number, AbilityName> = {}
  for (const id of ids) {
    const official = tc.get(id)
    if (official) result[id] = { name: official, source: 'tc' }
    else if (chs.has(id)) result[id] = { name: toTraditional(chs.get(id)!), source: 'chs' }
  }
  return result
}
