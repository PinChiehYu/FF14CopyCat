import { useState } from 'react'
import { EXTRA_HIT_WINDOW_MS, MITIGATION_GAP, notableRows, RECAP_WINDOW_MS, sortRows, type DamageRow, type DeathRecap, type SideHits } from '../analysis/damageTaken'
import { formatFightTime } from '../analysis/timeline'
import { abilityIconUrl } from '../fflogs/report'
import type { Ability } from '../fflogs/types'
import { HelpTip } from './HelpTip'

const percent = (v: number) => `${Math.round(v * 100)}%`

/** 減傷的顯示：受傷加重（倍率 > 1）時寫加重的比例 */
function mitigationLabel(m: number | null): string {
  if (m === null) return ''
  return m < 0 ? `受傷加重 ${percent(-m)}` : `減傷 ${percent(m)}`
}

function help(solo: boolean): string {
  return [
    '敵人對你的每一擊（DoT 跳傷不列入表格），依技能統計次數與平均減傷（1 − FFLogs 的承受倍率，含自身與隊友的減傷；受傷加重的一擊不列入平均）。',
    solo
      ? '紅色時間：被打中時被施加受傷加重或傷害降低，通常是機制處理失誤。'
      : `紅色時間：參考在對齊後的同一時間（前後 ${EXTRA_HIT_WINDOW_MS / 1000} 秒）沒有被這招打中，多半可以避開；Boss 普通攻擊不判斷。⚠：被打中時被施加受傷加重或傷害降低。`,
    !solo && `減傷標紅：這招每次（連續幾擊合計）未減傷時達最大血量 15% 以上，而你的平均減傷比參考少 ${percent(MITIGATION_GAP)} 以上。`,
    `死亡回顧：死前 ${RECAP_WINDOW_MS / 1000} 秒內的最後幾擊（含 DoT 跳傷）、血量與當時身上的減傷效果。`,
    '預設只列值得注意的技能，點「顯示全部」看所有技能。點擊時間跳到該處。',
  ]
    .filter(Boolean)
    .join('\n')
}

function Recap({
  recap,
  abilityName,
  mitigationAt,
  mineToRef,
  onJump,
}: {
  recap: DeathRecap
  abilityName: (id: number) => string
  mitigationAt: (t: number) => string[]
  mineToRef: (t: number) => number
  onJump: (t: number) => void
}) {
  const { death, hits, ref } = recap
  const killing = hits.findLast((h) => !h.tick) ?? hits.at(-1)
  const active = mitigationAt(death.t)
  return (
    <div className="death-recap">
      <div className="death-recap-head">
        <strong>
          {formatFightTime(death.t)} 死亡{death.abilityId !== null && `（${abilityName(death.abilityId)}）`}
        </strong>
        <button type="button" onClick={() => onJump(mineToRef(death.t))}>
          查看
        </button>
      </div>
      {hits.length === 0 ? (
        <p className="hint">死前 {RECAP_WINDOW_MS / 1000} 秒內沒有受到敵人的傷害紀錄。</p>
      ) : (
        <ol className="recap-hits">
          {hits.map((h, i) => (
            <li key={i}>
              <span className="recap-time">{formatFightTime(h.t)}</span>
              <span className="recap-name">
                {abilityName(h.abilityId)}
                {h.tick && <span className="hint-inline">（持續傷害）</span>}
              </span>
              {/* 各項不斷行，窄螢幕只在「·」之間換行 */}
              <span className="recap-meta">
                <span className="nowrap">{h.amount.toLocaleString()}</span>
                {h.hpBefore !== null && h.hpAfter !== null && (
                  <>
                    {' · '}
                    <span className="nowrap">
                      HP {percent(h.hpBefore)}→{percent(h.hpAfter)}
                    </span>
                  </>
                )}
                {h.mitigation !== null && !h.tick && (
                  <>
                    {' · '}
                    <span className="nowrap">{mitigationLabel(h.mitigation)}</span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="hint">身上的減傷：{active.length > 0 ? active.join('、') : '沒有'}</p>
      {ref && killing && (
        <p className="hint">
          參考在同一時間吃「{abilityName(killing.abilityId)}」受到 {ref.amount.toLocaleString()}
          {ref.mitigation !== null && `（${mitigationLabel(ref.mitigation)}）`}，{ref.died ? '也死亡' : '沒有死亡'}。
        </p>
      )}
    </div>
  )
}

function Cell({
  hits,
  row,
  showFlags,
  mineToRef,
  onJump,
}: {
  hits: SideHits
  row: DamageRow
  showFlags: boolean
  mineToRef: (t: number) => number
  onJump: (t: number) => void
}) {
  if (hits.count === 0) return <span className="hint-inline">沒有被打中</span>
  return (
    <span className="damage-cell">
      {/* 窄欄時只在「次數」與「減傷」之間換行 */}
      <span>
        <span className="nowrap">{hits.count} 次</span>
        {hits.mitigation !== null && (
          <>
            {' · '}
            <span className={`nowrap${showFlags && row.mitigationGap ? ' dot-low' : ''}`}>{mitigationLabel(hits.mitigation)}</span>
          </>
        )}
      </span>
      {showFlags && row.flagged.length > 0 && (
        <span className="damage-flags">
          {row.flagged.map((h, i) => (
            <button
              key={i}
              type="button"
              className="filler-chip avoidable"
              onClick={() => onJump(mineToRef(h.t))}
            >
              {formatFightTime(mineToRef(h.t))}
              {h.penalized && ' ⚠'}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

/** 受到的傷害：死亡回顧＋依技能的次數與減傷（我／參考）。 */
export function DamageTaken({
  rows,
  recaps,
  solo,
  abilities,
  abilityName,
  mitigationAt,
  mineToRef,
  onJump,
}: {
  rows: DamageRow[]
  recaps: DeathRecap[]
  solo: boolean
  abilities: Map<number, Ability>
  abilityName: (id: number) => string
  /** 我的時間當下身上的減傷效果名稱 */
  mitigationAt: (t: number) => string[]
  mineToRef: (t: number) => number
  onJump: (t: number) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const notable = notableRows(rows)
  const shown = showAll ? sortRows(rows) : notable
  return (
    <>
      <h3>
        受到的傷害
        <HelpTip text={help(solo)} />
      </h3>
      {recaps.map((r) => (
        <Recap key={r.death.t} recap={r} abilityName={abilityName} mitigationAt={mitigationAt} mineToRef={mineToRef} onJump={onJump} />
      ))}
      {shown.length === 0 ? (
        <p className="hint">{solo ? '沒有被打中後受到懲罰的傷害。' : '沒有參考沒被打中的傷害，也沒有明顯的減傷差距。'}</p>
      ) : (
        <table className="summary-table damage-table">
          <thead>
            <tr>
              <th />
              <th className="mine">我</th>
              {!solo && <th className="ref">參考</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const ability = abilities.get(row.abilityId)
              return (
                <tr key={row.abilityId}>
                  <th>
                    {ability && <img className="usage-icon" src={abilityIconUrl(ability.icon)} alt="" loading="lazy" />}
                    {abilityName(row.abilityId)}
                  </th>
                  <td>
                    <Cell hits={row.mine} row={row} showFlags mineToRef={mineToRef} onJump={onJump} />
                  </td>
                  {row.ref && (
                    <td>
                      <Cell hits={row.ref} row={row} showFlags={false} mineToRef={mineToRef} onJump={onJump} />
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {rows.length > notable.length && (
        <button type="button" className="damage-toggle" onClick={() => setShowAll((v) => !v)}>
          {showAll ? '只看值得注意的' : `顯示全部 ${rows.length} 個技能`}
        </button>
      )}
    </>
  )
}
