// 從遊戲資料（Boilmaster 鏡像的 Action 表）產生 src/jobs/generated.ts：
// - 所有 GCD 技能 ID：CooldownGroup 或 AdditionalCooldownGroup 為 58（公共冷卻）
// - 各職業減傷／移動／不紀錄／輔助技能的 ID：以下方的英文名稱查表，找不到就報錯（避免憑記憶寫錯 ID）
// 用法：node scripts/gen-job-data.mjs   （遊戲改版新增技能後重新執行）

import { writeFileSync } from 'node:fs'

const API = 'https://xivapi-v2.xivcdn.com/api/sheet/Action'
const FIELDS = 'Name,CooldownGroup,AdditionalCooldownGroup,IsPvP,IsPlayerAction,ClassJobLevel,ClassJob.Abbreviation'
const GCD_GROUP = 58

// 職業（FFLogs subType）→ 職業與基本職業的縮寫
const JOBS = {
  Paladin: ['PLD', 'GLA'],
  Warrior: ['WAR', 'MRD'],
  DarkKnight: ['DRK'],
  Gunbreaker: ['GNB'],
  WhiteMage: ['WHM', 'CNJ'],
  Scholar: ['SCH', 'ACN'],
  Astrologian: ['AST'],
  Sage: ['SGE'],
  Monk: ['MNK', 'PGL'],
  Dragoon: ['DRG', 'LNC'],
  Ninja: ['NIN', 'ROG'],
  Samurai: ['SAM'],
  Reaper: ['RPR'],
  Viper: ['VPR'],
  Bard: ['BRD', 'ARC'],
  Machinist: ['MCH'],
  Dancer: ['DNC'],
  BlackMage: ['BLM', 'THM'],
  Summoner: ['SMN', 'ACN'],
  RedMage: ['RDM'],
  Pictomancer: ['PCT'],
}

// 職業專屬技能分類（7.x 英文名稱）。職能技能（Rampart、Sprint 等）在 src/jobs/roleActions.ts。
// ignored：不需紀錄；mitigation：自身減傷（只保護自己）；partyMitigation：團隊減傷（可給隊友或降低敵人傷害：目標減傷、支援減傷）；
// movement：移動；utility：其他輔助
const CATEGORIES = {
  Paladin: {
    ignored: ['Iron Will', 'Release Iron Will'],
    mitigation: ['Sentinel', 'Guardian', 'Bulwark', 'Hallowed Ground', 'Sheltron', 'Holy Sheltron'],
    partyMitigation: ['Divine Veil', 'Intervention', 'Passage of Arms', 'Cover'],
    utility: ['Clemency'],
  },
  Warrior: {
    mitigation: ['Vengeance', 'Damnation', 'Raw Intuition', 'Bloodwhetting', 'Thrill of Battle', 'Holmgang'],
    partyMitigation: ['Nascent Flash', 'Shake It Off'],
    utility: ['Equilibrium'],
  },
  DarkKnight: {
    mitigation: ['Shadow Wall', 'Shadowed Vigil', 'Dark Mind', 'Living Dead'],
    partyMitigation: ['The Blackest Night', 'Oblation', 'Dark Missionary'],
    movement: ['Shadowstride'],
  },
  Gunbreaker: {
    mitigation: ['Nebula', 'Great Nebula', 'Camouflage', 'Superbolide'],
    partyMitigation: ['Aurora', 'Heart of Light', 'Heart of Stone', 'Heart of Corundum'],
    movement: ['Trajectory'],
  },
  WhiteMage: {
    partyMitigation: ['Temperance', 'Divine Caress', 'Aquaveil', 'Divine Benison'],
    movement: ['Aetherial Shift'],
  },
  Scholar: {
    partyMitigation: ['Sacred Soil', 'Expedient', 'Fey Illumination', 'Deployment Tactics'],
  },
  Astrologian: {
    partyMitigation: ['Collective Unconscious', 'Neutral Sect', 'Exaltation', 'Sun Sign'],
  },
  Sage: {
    partyMitigation: ['Kerachole', 'Holos', 'Panhaima', 'Haima', 'Taurochole'],
    movement: ['Icarus'],
  },
  Monk: {
    mitigation: ['Riddle of Earth'],
    partyMitigation: ['Mantra'],
    movement: ['Thunderclap'],
  },
  Dragoon: {
    movement: ['Elusive Jump', 'Winged Glide'],
  },
  Ninja: {
    mitigation: ['Shade Shift'],
    movement: ['Shukuchi'],
  },
  Samurai: {
    mitigation: ['Third Eye', 'Tengentsu'],
  },
  Reaper: {
    mitigation: ['Arcane Crest'],
    movement: ["Hell's Ingress", "Hell's Egress", 'Regress'],
  },
  Viper: {
    movement: ['Slither'],
  },
  Bard: {
    partyMitigation: ['Troubadour', "Nature's Minne"],
    movement: ['Repelling Shot'],
  },
  Machinist: {
    partyMitigation: ['Tactician', 'Dismantle'],
  },
  Dancer: {
    partyMitigation: ['Shield Samba', 'Improvisation', 'Curing Waltz'],
    movement: ['En Avant'],
  },
  BlackMage: {
    mitigation: ['Manaward'],
    movement: ['Aetherial Manipulation', 'Between the Lines', 'Retrace'],
  },
  Summoner: {
    mitigation: ['Radiant Aegis'],
  },
  RedMage: {
    partyMitigation: ['Magick Barrier'],
  },
  Pictomancer: {
    mitigation: ['Tempera Coat'],
    partyMitigation: ['Tempera Grassa'],
    movement: ['Smudge'],
  },
}

async function fetchAll() {
  const rows = []
  let after = 0
  for (;;) {
    const res = await fetch(`${API}?limit=500&after=${after}&fields=${FIELDS}&language=en`)
    if (!res.ok) throw new Error(`Action ${after}: ${res.status}`)
    const body = await res.json()
    if (body.rows.length === 0) break
    rows.push(...body.rows)
    after = body.rows.at(-1).row_id
    process.stderr.write(`\r${rows.length} rows`)
  }
  process.stderr.write('\n')
  return rows
}

const rows = await fetchAll()
const isPlayerSkill = (f) => !f.IsPvP && (f.IsPlayerAction || f.ClassJobLevel > 0)

// 所有非 PvP 的玩家技能中的 GCD（含沒有 ClassJob 的變形技能，例如 Midare Setsugekka）
const gcd = rows
  .filter((r) => isPlayerSkill(r.fields) && (r.fields.CooldownGroup === GCD_GROUP || r.fields.AdditionalCooldownGroup === GCD_GROUP))
  .map((r) => r.row_id)

// 依名稱找職業技能 ID：職業／基本職業的技能，加上同名、沒有 ClassJob 的變形技能
// （例如暗影步除了黑騎的 36926，日誌中實際記錄的是沒有 ClassJob 的 38512）
const errors = []
const categories = {}
for (const [subType, groups] of Object.entries(CATEGORIES)) {
  const abbrs = JOBS[subType]
  categories[subType] = {}
  for (const [kind, names] of Object.entries(groups)) {
    categories[subType][kind] = names.map((name) => {
      const candidates = rows.filter((r) => r.fields.Name === name && isPlayerSkill(r.fields))
      const own = candidates.filter((r) => abbrs.includes(r.fields.ClassJob?.fields?.Abbreviation))
      const pick = [...own, ...candidates.filter((r) => !r.fields.ClassJob?.fields?.Abbreviation)]
      if (pick.length === 0) errors.push(`${subType} ${kind}: 找不到「${name}」`)
      return { name, ids: pick.map((r) => r.row_id) }
    })
  }
}
if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exit(1)
}

const setLiteral = (entries) =>
  `new Set([\n${entries.flatMap(({ name, ids }) => ids.map((id) => `    ${id}, // ${name}`)).join('\n')}\n  ])`

const out = `// 由 scripts/gen-job-data.mjs 從遊戲資料產生，請勿手動修改；遊戲改版後重新執行腳本。
// 產生日期：${new Date().toISOString().slice(0, 10)}

/** 所有 GCD 技能 ID（公共冷卻群組 58），共 ${gcd.length} 個。 */
export const GCD_IDS: ReadonlySet<number> = new Set(${JSON.stringify(gcd)})

export interface GeneratedCategories {
  ignored?: ReadonlySet<number>
  mitigation?: ReadonlySet<number>
  partyMitigation?: ReadonlySet<number>
  movement?: ReadonlySet<number>
  utility?: ReadonlySet<number>
}

/** 各職業（FFLogs subType）的專屬技能分類。 */
export const JOB_CATEGORIES: Record<string, GeneratedCategories> = {
${Object.entries(categories)
  .map(
    ([subType, groups]) =>
      `  ${subType}: {\n${Object.entries(groups)
        .map(([kind, entries]) => `    ${kind}: ${setLiteral(entries).replace(/\n/g, '\n  ')},`)
        .join('\n')}\n  },`,
  )
  .join('\n')}
}
`
writeFileSync(new URL('../src/jobs/generated.ts', import.meta.url), out)
console.log(`GCD ${gcd.length} 個；${Object.keys(categories).length} 個職業的技能分類已寫入 src/jobs/generated.ts`)
