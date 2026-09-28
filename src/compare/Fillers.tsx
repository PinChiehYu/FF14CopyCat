import { formatFightTime } from '../analysis/timeline'
import { abilityIconUrl } from '../fflogs/report'
import type { Ability } from '../fflogs/types'
import { compareFillers, FILLER_MATCH_MS } from '../jobs/rangedFillers'
import { HelpTip } from './HelpTip'

/**
 * 止損技的使用：兩邊算止損的次數與時間（可點擊跳轉）。有參考時，我的每次依參考在同一段（前後 5 秒）有沒有用止損技區分：
 * 參考沒用的標紅（可以改善），參考也用了的灰色（多半是機制造成）。
 */
export function Fillers({
  fillerId,
  fillers,
  abilities,
  abilityName,
  mineToRef,
  onJump,
}: {
  fillerId: number
  /** 算止損的施放時間（各自的戰鬥時間）；沒有參考時 ref 為 null */
  fillers: { mine: number[]; ref: number[] | null }
  abilities: Map<number, Ability>
  abilityName: (id: number) => string
  mineToRef: (t: number) => number
  onJump: (t: number) => void
}) {
  const ability = abilities.get(fillerId)
  const name = abilityName(fillerId)
  const mineRef = fillers.mine.map(mineToRef)
  const onlyMine = new Set(fillers.ref ? compareFillers(mineRef, fillers.ref).onlyMine : [])
  const chips = (times: number[], mine: boolean) =>
    times.length === 0 ? (
      <span className="hint-inline">—</span>
    ) : (
      times.map((t, i) => (
        <button
          key={t}
          type="button"
          className={`filler-chip${mine && fillers.ref && !onlyMine.has(t) ? ' shared' : ''}${mine && onlyMine.has(t) ? ' avoidable' : ''}`}
          onClick={() => onJump(t)}
        >
          {formatFightTime(mine ? fillers.mine[i] : t).replace(/\.\d$/, '')}
        </button>
      ))
    )
  return (
    <>
      <h3>
        止損技
        <HelpTip
          text={[
            `${name}：近戰與坦克離開 Boss 時用來不斷 GCD 的遠程 GCD，威力低，用得多代表離 Boss 太遠或走位不順。`,
            '開場起手（開打前與第一個 GCD）與有強化效果時是正常打法，不列入。',
            fillers.ref &&
              `我的每次：紅色＝參考在同一段（前後 ${FILLER_MATCH_MS / 1000} 秒）沒有用止損技，可以改善；灰色＝參考也用了，多半是機制造成。`,
            '時間為各自的戰鬥時間，點擊跳到該處。',
          ]
            .filter(Boolean)
            .join('\n')}
        />
      </h3>
      <table className="summary-table fillers-table">
        <tbody>
          <tr>
            <th className="mine">
              {ability && <img className="usage-icon filler" src={abilityIconUrl(ability.icon)} alt="" loading="lazy" />}我{' '}
              <strong>{fillers.mine.length}</strong> 次
            </th>
            <td>{chips(mineRef, true)}</td>
          </tr>
          {fillers.ref && (
            <tr>
              <th className="ref">
                {ability && <img className="usage-icon filler" src={abilityIconUrl(ability.icon)} alt="" loading="lazy" />}參考{' '}
                <strong>{fillers.ref.length}</strong> 次
              </th>
              <td>{chips(fillers.ref, false)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  )
}
