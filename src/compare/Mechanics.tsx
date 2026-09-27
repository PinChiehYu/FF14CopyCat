import { mechanicLabel, mergeRepeats, sameNameVariants, type MechanicDifference } from '../analysis/mechanics'
import { formatFightTime } from '../analysis/timeline'

const MAIN_TIP = '依 cactbot 時間軸列出的機制（玩家需要處理的攻擊），不含輔助判定與連續攻擊的每一下'

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
}: {
  differences: MechanicDifference[]
  /** 只比較主要機制（有 cactbot 資料的 Boss） */
  main: boolean
  abilityName: (id: number) => string
  onJump: (t: number) => void
}) {
  const scope = main ? '主要機制' : '機制（低頻技能）'
  if (differences.length === 0) {
    return <p className="hint">兩場戰鬥的 Boss {scope}在對齊後相同，沒有隨機變化的差異。</p>
  }
  // 名稱只列一次、不附技能 ID；ID 放在滑鼠提示
  const label = (ids: number[]) => (ids.length === 0 ? '—' : mechanicLabel(ids, [], abilityName, { withIds: false }))
  // 同一招連續結算的多個時間點合併成一列（顯示第一個時間點）
  const rows = mergeRepeats(differences, abilityName)

  const sameNames = (mine: number[], ref: number[]) => {
    const names = (ids: number[]) => [...new Set(ids.map(abilityName))].sort().join('、')
    return names(mine) === names(ref)
  }
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
        對齊後共 {rows.length} 處 Boss{' '}
        {main ? <span className="has-tip" title={MAIN_TIP}>主要機制</span> : '機制'}不同（其中 {rows.filter((d) => d.kind === 'variant').length}{' '}
        處是同一時間施放不同技能，通常是隨機變化）。這些時間點的站位或走位差異可能是機制造成，不一定是錯誤。
        推進時間不同（例如轉場提早）造成的只有一邊的機制不列出。
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
                {/* 兩邊名稱完全相同的不同變化（例如方向不同的版本）寫「不同版本」，比「不同變化」好懂 */}
                <td className="mech-kind">{d.kind === 'variant' && sameNames(d.mine, d.ref) ? '不同版本' : KIND_LABELS[d.kind]}</td>
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
