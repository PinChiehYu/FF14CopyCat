import { mechanicLabel, mergeRepeats, sameNameVariants, type MechanicDifference } from '../analysis/mechanics'
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
  // 名稱只列一次、不附技能 ID；ID 放在滑鼠提示
  const label = (ids: number[]) => (ids.length === 0 ? '—' : mechanicLabel(ids, [], abilityName, { withIds: false }))
  // 同一招連續結算的多個時間點合併成一列（顯示第一個時間點）
  const rows = mergeRepeats(differences, abilityName)

  const cell = (ids: number[], variants: string[]) => {
    const idList = ids.map((id) => `#${id}`).join(' ')
    // 兩邊名稱相同但技能 ID 不同：畫面看起來一樣，以虛線底線提示滑鼠停留查看
    const title =
      variants.length > 0
        ? `${variants.join('、')}：名稱相同但技能 ID 不同，通常是方向或位置不同的版本（${idList}）`
        : ids.length > 1
          ? idList
          : undefined
    return (
      <td title={title} className={variants.length > 0 ? 'id-variant' : undefined}>
        {label(ids)}
      </td>
    )
  }

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
          {rows.map((d) => {
            const variants = sameNameVariants(d.mine, d.ref, abilityName)
            return (
              <tr key={d.t}>
                <th>
                  <button type="button" onClick={() => onJump(d.t)}>
                    {formatFightTime(d.t)}
                  </button>
                </th>
                <td className="mech-kind">{KIND_LABELS[d.kind]}</td>
                {cell(d.mine, variants)}
                {cell(d.ref, variants)}
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}
