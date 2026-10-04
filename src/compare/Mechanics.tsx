import { mechanicLabel, mergeRepeats, type MechanicDifference } from '../analysis/mechanics'
import { formatFightTime } from '../analysis/timeline'
import { HelpTip } from './HelpTip'

/** 「Boss 機制差異」標題旁的說明 */
function mechanicsHelp(main: boolean): string {
  return [
    main
      ? '只比較主要機制：cactbot 時間軸列出的玩家需要處理的攻擊，不含輔助判定與連續攻擊的每一下。'
      : '比較 Boss 的低頻技能（這個 Boss 沒有 cactbot 資料）。',
    '不同變化：同一時間兩邊施放不同技能，通常是隨機變化；不同版本：名稱相同但技能 ID 不同，通常是方向或位置不同。',
    '這些時間點的站位或走位差異可能是機制造成，不一定是錯誤。推進時間不同（例如轉場提早）造成的只有一邊的機制不列出。',
    '深藍色左條：你在「搜尋前輩日誌」中關注的機制時間點（有取消勾選時才標）。',
  ].join('\n')
}

export function MechanicsHeading({ main }: { main: boolean }) {
  return (
    <h3>
      Boss 機制差異
      <HelpTip text={mechanicsHelp(main)} />
    </h3>
  )
}

const KIND_LABELS: Record<MechanicDifference['kind'], string> = {
  variant: '不同變化',
  'only-mine': '只有我',
  'only-ref': '只有參考',
}

export function Mechanics({
  differences,
  main,
  abilityName,
  onJump,
  isFocused,
  refToMine,
}: {
  differences: MechanicDifference[]
  /** 只比較主要機制（有 cactbot 資料的 Boss） */
  main: boolean
  abilityName: (id: number) => string
  onJump: (t: number) => void
  /** 關注的機制時間點（技能 ID、我的時間；見 focusedMechanics.ts），對到的列高光；沒有選擇時為 null */
  isFocused?: ((abilityId: number, mineT: number) => boolean) | null
  refToMine: (t: number) => number
}) {
  const scope = main ? '主要機制' : '機制（低頻技能）'
  if (differences.length === 0) {
    return <p className="hint">兩場戰鬥的 Boss {scope}在對齊後相同，沒有隨機變化的差異。</p>
  }
  // 名稱只列一次、不附技能 ID；ID 放在滑鼠提示
  const label = (ids: number[]) => (ids.length === 0 ? '—' : mechanicLabel(ids, [], abilityName))
  // 同一招連續結算的多個時間點合併成一列（顯示第一個時間點）
  const rows = mergeRepeats(differences, abilityName)

  const sameNames = (mine: number[], ref: number[]) => {
    const names = (ids: number[]) => [...new Set(ids.map(abilityName))].sort().join('、')
    return names(mine) === names(ref)
  }

  return (
    <>
      {/* 各處的類型在表格中，這裡只列總數 */}
      <p>共 {rows.length} 處不同。</p>
      <table className="metrics-table mechanics">
        <thead>
          <tr>
            <th>時間（參考）</th>
            <th>類型</th>
            <th className="mine">我的 Boss</th>
            <th className="ref">參考的 Boss</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            return (
              <tr
                key={d.t}
                className={isFocused && [...d.mine, ...d.ref].some((id) => isFocused(id, refToMine(d.t))) ? 'focused' : undefined}
              >
                <th>
                  <button type="button" onClick={() => onJump(d.t)}>
                    {formatFightTime(d.t)}
                  </button>
                </th>
                {/* 兩邊名稱完全相同的不同變化（例如方向不同的版本）寫「不同版本」，比「不同變化」好懂 */}
                <td className="mech-kind">{d.kind === 'variant' && sameNames(d.mine, d.ref) ? '不同版本' : KIND_LABELS[d.kind]}</td>
                <td>{label(d.mine)}</td>
                <td>{label(d.ref)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}
