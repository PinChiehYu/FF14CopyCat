import { mechanicLabel, mergeRepeats, type MechanicDifference } from '../analysis/mechanics'
import { formatFightTime } from '../analysis/timeline'

const KIND_LABELS: Record<MechanicDifference['kind'], string> = {
  variant: '不同變化',
  'only-mine': '只有我',
  'only-ref': '只有參考',
}

export function Mechanics({
  differences,
  abilityName,
  onJump,
}: {
  differences: MechanicDifference[]
  abilityName: (id: number) => string
  onJump: (t: number) => void
}) {
  if (differences.length === 0) {
    return <p className="hint">兩場戰鬥的 Boss 機制（低頻技能）在對齊後相同，沒有隨機變化的差異。</p>
  }
  const label = (ids: number[], others: number[]) => (ids.length === 0 ? '—' : mechanicLabel(ids, others, abilityName))
  // 合併成一個名稱的多個 ID 放在滑鼠提示
  const idsTitle = (ids: number[]) => (ids.length > 1 ? ids.map((id) => `#${id}`).join(' ') : undefined)
  // 同一招連續結算的多個時間點合併成一列
  const rows = mergeRepeats(differences, abilityName)

  return (
    <>
      <p>
        對齊後共 {rows.length} 處 Boss 機制不同（其中 {rows.filter((d) => d.kind === 'variant').length}{' '}
        處是同一時間施放不同技能，通常是隨機變化）。這些時間點的站位或走位差異可能是機制造成，不一定是錯誤。
        「只有一邊」的機制，常是輸出較高的一方提早轉場而跳過。
      </p>
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
          {rows.map((d) => (
            <tr key={d.t}>
              <th>
                <button type="button" onClick={() => onJump(d.t)}>
                  {formatFightTime(d.t)}
                </button>
                {d.count > 1 && <span className="hint-inline">～{formatFightTime(d.last)}</span>}
              </th>
              <td>
                {KIND_LABELS[d.kind]}
                {d.count > 1 && <span className="hint-inline">（連續 {d.count} 次）</span>}
              </td>
              <td title={idsTitle(d.mine)}>{label(d.mine, d.ref)}</td>
              <td title={idsTitle(d.ref)}>{label(d.ref, d.mine)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
