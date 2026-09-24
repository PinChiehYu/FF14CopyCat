import type { MechanicDifference } from '../analysis/mechanics'
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
  // 同名不同 ID 的技能（例如左右兩種版本）附上 ID 才分得出來
  const label = (ids: number[], others: number[]) =>
    ids.length === 0
      ? '—'
      : ids
          .map((id) => {
            const name = abilityName(id)
            const ambiguous = others.some((o) => o !== id && abilityName(o) === name)
            return ambiguous ? `${name} #${id}` : name
          })
          .join('、')

  return (
    <>
      <p>
        對齊後共 {differences.length} 處 Boss 機制不同（其中 {differences.filter((d) => d.kind === 'variant').length}{' '}
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
          {differences.map((d) => (
            <tr key={d.t}>
              <th>
                <button type="button" onClick={() => onJump(d.t)}>
                  {formatFightTime(d.t)}
                </button>
              </th>
              <td>{KIND_LABELS[d.kind]}</td>
              <td>{label(d.mine, d.ref)}</td>
              <td>{label(d.ref, d.mine)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
