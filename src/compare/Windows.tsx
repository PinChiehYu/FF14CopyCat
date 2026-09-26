import { formatFightTime } from '../analysis/timeline'
import { windowState, windowTitle, type WindowSummary } from '../analysis/windows'
import { abilityIconUrl, isStatusId } from '../fflogs/report'
import type { Ability } from '../fflogs/types'
import { ruleDisplayId, ruleName } from '../jobs/windows'

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
  // 這一邊的遊戲版本沒有這條規則
  if (summary.inapplicable) {
    return (
      <span className="hint-inline" title={summary.inapplicable}>
        不適用
      </span>
    )
  }
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
  abilityName,
  mineToRef,
  onJump,
}: {
  windows: { mine: WindowSummary; ref: WindowSummary }[]
  abilities: Map<number, Ability>
  abilityName: (id: number) => string
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
          const displayId = ruleDisplayId(mine.rule)
          const icon = abilities.get(displayId)
          return (
            <tr key={mine.rule.key}>
              <th title={[icon?.englishName, ...new Set([mine.rule.patchNote, ref.rule.patchNote])].filter(Boolean).join('\n')}>
                {icon && (
                  <img
                    className={`usage-icon${isStatusId(displayId) ? ' status-icon' : ''}`}
                    src={abilityIconUrl(icon.icon)}
                    alt=""
                    loading="lazy"
                  />
                )}
                {ruleName(mine.rule, abilityName)}
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
