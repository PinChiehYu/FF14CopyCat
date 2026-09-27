// 從 cactbot 的時間軸產生 src/analysis/mechanicData.generated.ts：各 Boss 的「主要機制」技能 ID。
// cactbot（OverlayPlugin/cactbot，Apache-2.0）的時間軸只列每個機制的主要技能 ID（玩家需要處理的攻擊），
// 同一行列出多個 ID 的是同一機制的不同版本（例如掃擊／旋擊群狼劍）。技能 ID 與繁中服相同。
// - 以 "--" 開頭的名稱（--sync--、--middle-- 等）是對齊用的輔助技能，不列入
// - 同一行的 ID、以及出現在多行的同一 ID 合併成同一組機制
// 用法：node scripts/gen-mechanics.mjs   （換季時更新下方的 ENCOUNTERS 後重新執行）

import { writeFileSync } from 'node:fs'

const BASE = 'https://raw.githubusercontent.com/OverlayPlugin/cactbot/main/ui/raidboss/data'
// FFLogs encounterID → cactbot 時間軸
const ENCOUNTERS = {
  97: { name: 'Dancing Green (M5S)', file: '07-dt/raid/r5s.txt' },
  98: { name: 'Sugar Riot (M6S)', file: '07-dt/raid/r6s.txt' },
  99: { name: 'Brute Abombinator (M7S)', file: '07-dt/raid/r7s.txt' },
  100: { name: 'Howling Blade (M8S)', file: '07-dt/raid/r8s.txt' },
}

// 例：29.5 "Stonefang/Windfang" Ability { id: ["A39E", "A39D"], source: "Howling Blade" }
// 註解掉的 #Ability／# Ability（不同步但仍是實際攻擊）也收錄
const LINE = /^\s*[\d.]+\s+"([^"]*)"\s+(?:#\s*)?Ability\s*\{\s*id:\s*(\[[^\]]*\]|"[0-9A-Fa-f]+")/

function parse(text) {
  const parent = new Map()
  const find = (x) => {
    while (parent.get(x) !== x) x = parent.get(x)
    return x
  }
  const add = (x) => parent.has(x) || parent.set(x, x)
  for (const line of text.split('\n')) {
    const m = LINE.exec(line)
    if (!m || m[1].startsWith('--')) continue
    const ids = [...m[2].matchAll(/"([0-9A-Fa-f]+)"/g)].map((x) => parseInt(x[1], 16))
    ids.forEach(add)
    for (const id of ids.slice(1)) parent.set(find(id), find(ids[0]))
  }
  const groups = new Map()
  for (const id of parent.keys()) {
    const root = find(id)
    groups.set(root, [...(groups.get(root) ?? []), id])
  }
  return [...groups.values()].map((g) => g.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0])
}

const out = []
for (const [encounter, { name, file }] of Object.entries(ENCOUNTERS)) {
  const res = await fetch(`${BASE}/${file}`)
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
  const groups = parse(await res.text())
  if (groups.length === 0) throw new Error(`${file}: no abilities parsed`)
  console.log(`${encounter} ${name}: ${groups.length} mechanics, ${groups.flat().length} ids`)
  out.push(`  // ${name}（cactbot ${file}）\n  ${encounter}: ${JSON.stringify(groups)},`)
}

writeFileSync(
  new URL('../src/analysis/mechanicData.generated.ts', import.meta.url),
  `// 由 scripts/gen-mechanics.mjs 從 cactbot（Apache-2.0）的時間軸產生，不要手改。
// FFLogs encounterID → 主要機制；每組是同一機制（含不同版本）的技能 ID。
export const MAIN_MECHANICS: Record<number, number[][]> = {
${out.join('\n')}
}
`,
)
