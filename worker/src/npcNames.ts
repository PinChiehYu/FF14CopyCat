import { Converter } from 'opencc-js/cn2t'

// FFLogs 的戰鬥名稱是 Boss 的英文名稱；NPC 的 gameID 是 BNpcBase，與名稱表（BNpcName）沒有對應，
// 因此以英文名稱搜尋 BNpcName，再取該列的繁中名稱
const XIVAPI = 'https://xivapi-v2.xivcdn.com/api'

const toTraditional = Converter({ from: 'cn', to: 'tw' })

function usable(name: unknown): name is string {
  return typeof name === 'string' && name.trim() !== '' && !name.startsWith('_rsv_')
}

async function findRow(name: string): Promise<number | null> {
  const query = encodeURIComponent(`Singular="${name}"`)
  const res = await fetch(`${XIVAPI}/search?sheets=BNpcName&query=${query}&fields=Singular&language=en&limit=1`)
  if (!res.ok) throw new Error(`xivapi search ${res.status}`)
  const body = (await res.json()) as { results?: { row_id: number }[] }
  return body.results?.[0]?.row_id ?? null
}

async function rowName(row: number, language: 'tc' | 'chs'): Promise<string | null> {
  const res = await fetch(`${XIVAPI}/sheet/BNpcName/${row}?fields=Singular&language=${language}`)
  if (!res.ok) return null
  const body = (await res.json()) as { fields?: { Singular?: string } }
  return usable(body.fields?.Singular) ? body.fields!.Singular! : null
}

export interface NpcName {
  name: string
  /** tc：官方繁中；chs：簡中轉繁 */
  source: 'tc' | 'chs'
}

/** 以英文名稱查 NPC（Boss）的繁中名稱；找不到的不回傳，由前端沿用英文。 */
export async function npcNames(names: string[]): Promise<Record<string, NpcName>> {
  const result: Record<string, NpcName> = {}
  await Promise.all(
    names.map(async (name) => {
      // 名稱表的搜尋區分大小寫，而遊戲中部分 NPC 名稱是小寫（例如 striking dummy）
      const row = (await findRow(name)) ?? (name !== name.toLowerCase() ? await findRow(name.toLowerCase()) : null)
      if (row === null) return
      const tc = await rowName(row, 'tc')
      if (tc) {
        result[name] = { name: tc, source: 'tc' }
        return
      }
      const chs = await rowName(row, 'chs')
      if (chs) result[name] = { name: toTraditional(chs), source: 'chs' }
    }),
  )
  return result
}
