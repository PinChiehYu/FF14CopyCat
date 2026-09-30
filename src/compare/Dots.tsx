import { clipSeverity, type DotSummary } from '../analysis/dots'
import { abilityIconUrl } from '../fflogs/report'
import type { Ability } from '../fflogs/types'
import { fflogsStatusId } from '../jobs/dotRules'
import { HelpTip } from './HelpTip'

/** 「DoT」標題旁的說明 */
const DOTS_HELP = [
  '覆蓋率：DoT 在敵人身上的時間 ÷ Boss 可選中的時間（Boss 無法選中的時間不算）；未達目標時標紅。',
  '提早續上：DoT 還沒結束就再施加，覆蓋掉的剩餘時間，換算成每分鐘幾秒；達到提醒門檻時標色，點擊跳到覆蓋最多的一次。',
  '時間軸的 GCD 列頂部也有標示：金黃線為 DoT 斷掉的時段、金黃短直線為提早續上超過一個 GCD 的時間點。',
  '規則、目標與門檻移植自 xivanalysis 各職業的 DoT 模組（單體與範圍版合併計算，兩者互換不算提早續上）。',
].join('\n')

export function DotsHeading() {
  return (
    <h3>
      DoT
      <HelpTip text={DOTS_HELP} />
    </h3>
  )
}

function Cell({ summary, toRef, onJump }: { summary: DotSummary; toRef: (t: number) => number; onJump: (t: number) => void }) {
  const low = summary.uptime < summary.rule.uptimeTarget
  const severity = clipSeverity(summary)
  const worst = summary.clips.reduce<{ t: number; ms: number } | null>((a, b) => (a && a.ms >= b.ms ? a : b), null)
  return (
    <span className="dot-cell">
      <span className={low ? 'dot-low' : undefined}>
        覆蓋 <strong>{summary.uptime.toFixed(1)}%</strong>
      </span>
      {summary.clipPerMinMs !== null && (
        <>
          {/* 手機上覆蓋率與提早續上分兩行，不顯示分隔點 */}
          <span className="dot-sep"> · </span>
          {worst ? (
            <button type="button" className={`dot-clip${severity ? ` ${severity}` : ''}`} onClick={() => onJump(toRef(worst.t))}>
              提早 {(summary.clipPerMinMs / 1000).toFixed(1)} 秒／分
            </button>
          ) : (
            <span className="hint-inline">沒有提早續上</span>
          )}
        </>
      )}
    </span>
  )
}

/** 各 DoT 一列：我／參考的覆蓋率與提早續上。 */
export function Dots({
  dots,
  abilities,
  abilityName,
  mineToRef,
  onJump,
}: {
  dots: { mine: DotSummary; ref: DotSummary | null }[]
  abilities: Map<number, Ability>
  abilityName: (id: number) => string
  mineToRef: (t: number) => number
  onJump: (t: number) => void
}) {
  const hasRef = dots.some((d) => d.ref !== null)
  return (
    <table className="summary-table dots-table">
      <thead>
        <tr>
          <th />
          <th className="mine">我</th>
          {hasRef && <th className="ref">參考</th>}
        </tr>
      </thead>
      <tbody>
        {dots.map(({ mine, ref }) => {
          const ids = mine.rule.statusIds.map(fflogsStatusId)
          const icon = abilities.get(ids[0])
          return (
            <tr key={mine.rule.key}>
              <th>
                {icon && <img className="usage-icon status-icon" src={abilityIconUrl(icon.icon)} alt="" loading="lazy" />}
                {/* 多個名稱只在「／」處換行，不把單一名稱拆開 */}
                {ids.map((id, i) => (
                  <span key={id} className="name-part">
                    {abilityName(id)}
                    {i < ids.length - 1 && '／'}
                  </span>
                ))}
                <span className="rule-duration">目標 {mine.rule.uptimeTarget}%</span>
              </th>
              <td>
                <Cell summary={mine} toRef={mineToRef} onJump={onJump} />
              </td>
              {ref && (
                <td>
                  <Cell summary={ref} toRef={(t) => t} onJump={onJump} />
                </td>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
