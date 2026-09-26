import { formatFightTime } from '../analysis/timeline'
import { windowState, windowTitle, type WindowSummary } from '../analysis/windows'
import { abilityIconUrl } from '../fflogs/report'
import type { Ability } from '../fflogs/types'

function Chips({
  summary,
  toRef,
  onJump,
}: {
  summary: WindowSummary
  /** 這一側的時間換算成參考時間 */
  toRef: (t: number) => number
  onJump: (t: number) => void
}) {
  return (
    <>
      <span className="window-score">
        {summary.passed}/{summary.judged}
      </span>
      <span className="window-chips">
        {summary.windows.map((w) => (
          <button
            key={w.start}
            type="button"
            className={`window-chip ${windowState(w)}`}
            title={windowTitle(w)}
            onClick={() => onJump(toRef(w.start))}
          >
            {formatFightTime(w.start).replace(/\.\d$/, '')}
          </button>
        ))}
      </span>
    </>
  )
}

/** 技能窗口：兩邊各自依職業規則評分，每個窗口一個可點擊的時間標籤（綠：合格、紅：有問題、灰：不評分）。 */
export function Windows({
  windows,
  abilities,
  mineToRef,
  onJump,
}: {
  windows: { mine: WindowSummary; ref: WindowSummary }[]
  abilities: Map<number, Ability>
  mineToRef: (t: number) => number
  onJump: (t: number) => void
}) {
  return (
    <table className="summary-table windows-table">
      <thead>
        <tr>
          <th />
          <th className="mine">我</th>
          <th className="ref">參考</th>
        </tr>
      </thead>
      <tbody>
        {windows.map(({ mine, ref }) => {
          const status = abilities.get(mine.rule.statusId)
          return (
            <tr key={mine.rule.key}>
              <th title={status?.englishName}>
                {status && <img className="usage-icon" src={abilityIconUrl(status.icon)} alt="" loading="lazy" />}
                {status?.name ?? `#${mine.rule.statusId}`}
              </th>
              <td>
                <Chips summary={mine} toRef={mineToRef} onJump={onJump} />
              </td>
              <td>
                <Chips summary={ref} toRef={(t) => t} onJump={onJump} />
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
