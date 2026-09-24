import type { Alignment } from '../analysis/alignment'
import { abilityUsage, gcdStats, type LostWindow } from '../analysis/metrics'
import { formatFightTime } from '../analysis/timeline'
import { abilityIconUrl } from '../fflogs/report'
import type { Ability } from '../fflogs/types'
import type { JobModule } from '../jobs'
import type { SideData } from './load'

const seconds = (ms: number, digits = 1) => (ms / 1000).toFixed(digits)

function signed(value: number, digits = 1): string {
  const text = value.toFixed(digits)
  return value > 0 ? `+${text}` : text
}

function GcdSection({
  mine,
  reference,
  lost,
  onFocus,
}: {
  mine: ReturnType<typeof gcdStats>
  reference: ReturnType<typeof gcdStats>
  lost: LostWindow[]
  onFocus: (refTime: number) => void
}) {
  const lostTotal = lost.reduce((sum, w) => sum + w.refGcds, 0)
  const slower = mine.gcdMs !== null && reference.gcdMs !== null ? mine.gcdMs - reference.gcdMs : 0

  return (
    <>
      <h3>GCD</h3>
      <table className="metrics-table">
        <thead>
          <tr>
            <th />
            <th className="mine">我</th>
            <th className="ref">參考</th>
            <th>差距</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>GCD 數</th>
            <td>{mine.count}</td>
            <td>{reference.count}</td>
            <td>{signed(mine.count - reference.count, 0)}</td>
          </tr>
          <tr>
            <th>GCD 間隔</th>
            <td>{mine.gcdMs !== null ? `${seconds(mine.gcdMs, 3)} 秒` : '—'}</td>
            <td>{reference.gcdMs !== null ? `${seconds(reference.gcdMs, 3)} 秒` : '—'}</td>
            <td>{slower ? `${signed(slower, 0)} 毫秒` : '—'}</td>
          </tr>
          <tr>
            <th>空檔總計</th>
            <td>{seconds(mine.idleMs)} 秒</td>
            <td>{seconds(reference.idleMs)} 秒</td>
            <td>{signed((mine.idleMs - reference.idleMs) / 1000)} 秒</td>
          </tr>
        </tbody>
      </table>
      <p className="hint">
        GCD 間隔取開始施放時間的中位數；空檔含 Boss 無法攻擊的時間，與參考的差距才有意義。
        {slower > 10 && ` 你的 GCD 比參考慢 ${slower.toFixed(0)} 毫秒，可能是技能速度或加速效果的差異。`}
      </p>

      <h3>少打 GCD 的時段</h3>
      {lost.length === 0 ? (
        <p className="hint">沒有「你停手但參考仍在施放」的時段。</p>
      ) : (
        <>
          <p>
            共 {lost.length} 段，參考在這些時段多打了 {lostTotal} 個 GCD。雙方都停手的時段（Boss 無法攻擊等）不列入。
          </p>
          <ul className="lost-list">
            {lost.map((w) => (
              <li key={w.mineStart}>
                <button type="button" onClick={() => onFocus(w.refStart)}>
                  {formatFightTime(w.mineStart)}–{formatFightTime(w.mineEnd)}
                </button>{' '}
                停手 {seconds(w.mineEnd - w.mineStart)} 秒；參考在同一段打了 <strong>{w.refGcds}</strong> 個 GCD
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

export function Metrics({
  mine,
  reference,
  alignment,
  abilities,
  job,
  lost,
  onFocus,
}: {
  mine: SideData
  reference: SideData
  alignment: Alignment
  abilities: Map<number, Ability>
  job: JobModule | undefined
  lost: LostWindow[]
  onFocus: (refTime: number) => void
}) {
  const usage = abilityUsage(mine.playerCasts, reference.playerCasts, alignment.mineToRef)
  const gcdTimes = (side: SideData) => side.playerCasts.filter((c) => job?.isGcd(c.abilityId)).map((c) => c.t)

  return (
    <section className="metrics">
      {job ? (
        <GcdSection
          mine={gcdStats(gcdTimes(mine))}
          reference={gcdStats(gcdTimes(reference))}
          lost={lost}
          onFocus={onFocus}
        />
      ) : (
        <p className="hint">此職業尚未有專屬規則，無法計算 GCD 指標。</p>
      )}

      <h3>技能使用次數</h3>
      <table className="metrics-table usage">
        <thead>
          <tr>
            <th>技能</th>
            <th className="mine">我</th>
            <th className="ref">參考</th>
            <th>差距</th>
            <th>平均時機</th>
          </tr>
        </thead>
        <tbody>
          {usage.map((u) => {
            const ability = abilities.get(u.abilityId)
            const timing =
              u.avgDelayMs === null
                ? '—'
                : Math.abs(u.avgDelayMs) < 500
                  ? '相同'
                  : `${u.avgDelayMs > 0 ? '晚' : '早'} ${seconds(Math.abs(u.avgDelayMs))} 秒`
            return (
              <tr key={u.abilityId} className={u.mine < u.ref ? 'fewer' : undefined}>
                <th>
                  {ability && <img className="usage-icon" src={abilityIconUrl(ability.icon)} alt="" loading="lazy" />}
                  {ability?.name ?? `#${u.abilityId}`}
                  {job && (job.isGcd(u.abilityId) ? <span className="tag">GCD</span> : null)}
                </th>
                <td>{u.mine}</td>
                <td>{u.ref}</td>
                <td>{u.mine === u.ref ? '' : signed(u.mine - u.ref, 0)}</td>
                <td>{timing}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="hint">
        平均時機：把你（依 Boss 機制對齊後）與參考的每次使用依序配對（相距 30 秒以內才算同一次），計算你平均早或晚多少；
        使用 30 次以上的技能（連擊等）不計算。
      </p>
    </section>
  )
}
