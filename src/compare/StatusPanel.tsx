import type { TimedCast } from '../analysis/alignment'
import { aurasAt, hpAt, type Aura } from '../analysis/buffs'
import { formatFightTime } from '../analysis/timeline'
import { abilityIconUrl } from '../fflogs/report'
import type { Ability } from '../fflogs/types'
import type { SideData } from './load'

// Boss 施放：顯示游標前後這段時間內的
const BOSS_WINDOW_MS = 5000

function AuraIcon({ aura, t, ability, name }: { aura: Aura; t: number; ability: Ability | undefined; name: string }) {
  const remaining = (aura.end - t) / 1000
  const title = `${name} 剩 ${remaining.toFixed(1)} 秒`
  return ability?.icon ? (
    <span className="aura-wrap" title={title}>
      <img className="aura" src={abilityIconUrl(ability.icon)} alt={name} loading="lazy" />
      {/* 剩餘秒數（長效的如進食、坦姿不顯示） */}
      {remaining < 100 && <span className="aura-time">{Math.ceil(remaining)}</span>}
    </span>
  ) : (
    <span className="aura aura-text" title={title}>
      {name.slice(0, 2)}
    </span>
  )
}

function SideStatus({
  label,
  side,
  t,
  abilities,
  abilityName,
}: {
  label: string
  side: SideData
  /** 這一側的戰鬥時間 */
  t: number
  abilities: Map<number, Ability>
  abilityName: (id: number) => string
}) {
  const hp = hpAt(side.hp, t)
  const pct = hp ? Math.round((hp.hp / hp.maxHp) * 100) : null
  const player = side.selection.player
  // 只列角色自己的 Buff（學習重點）；隊友給的 Buff 與敵人給的 Debuff 不顯示
  const buffs = aurasAt(side.auras, t).filter((a) => a.sourceId === player.id && !a.debuff)
  const icon = (a: Aura) => (
    <AuraIcon key={a.statusId} aura={a} t={t} ability={abilities.get(a.statusId)} name={abilityName(a.statusId)} />
  )
  return (
    <div className="side-status">
      <div className="side-status-head">
        <span className={label === '我' ? 'mine' : 'ref'}>{label}</span>
        <span className="hint-inline">{formatFightTime(Math.max(0, t))}</span>
      </div>
      <div className="hp-bar" title={hp ? `${hp.hp.toLocaleString()} / ${hp.maxHp.toLocaleString()}` : '沒有血量資料'}>
        <span className="hp-fill" style={{ width: `${pct ?? 0}%` }} />
        {hp && hp.absorb > 0 && <span className="hp-shield" style={{ width: `${Math.min(100, hp.absorb)}%` }} />}
        <span className="hp-text">{pct === null ? '—' : `${pct}%`}</span>
      </div>
      <div className="aura-row">{buffs.length > 0 ? buffs.map(icon) : <span className="hint-inline">沒有自身 Buff</span>}</div>
    </div>
  )
}

/** 游標時間點上，兩邊玩家的血量與自身 Buff，以及 Boss 最近與即將施放的技能。 */
export function StatusPanel({
  mine,
  reference,
  cursor,
  refToMine,
  bossCasts,
  abilities,
  abilityName,
}: {
  mine: SideData
  reference: SideData
  /** 參考時間 */
  cursor: number
  refToMine: (t: number) => number
  /** 參考日誌的 Boss 施放（參考時間） */
  bossCasts: TimedCast[]
  abilities: Map<number, Ability>
  abilityName: (id: number) => string
}) {
  const recent = bossCasts.filter((c) => c.t <= cursor && c.t > cursor - BOSS_WINDOW_MS).at(-1)
  const upcoming = bossCasts.find((c) => c.t > cursor && c.t <= cursor + BOSS_WINDOW_MS)
  return (
    <div className="status-panel">
      <p className="boss-now">
        <span className="legend boss">● Boss</span>{' '}
        {recent ? `${abilityName(recent.abilityId)}（${((cursor - recent.t) / 1000).toFixed(1)} 秒前）` : '—'}
        {upcoming && <span className="hint-inline">　接著：{abilityName(upcoming.abilityId)}（{((upcoming.t - cursor) / 1000).toFixed(1)} 秒後）</span>}
      </p>
      <SideStatus label="我" side={mine} t={refToMine(cursor)} abilities={abilities} abilityName={abilityName} />
      <SideStatus label="參考" side={reference} t={cursor} abilities={abilities} abilityName={abilityName} />
    </div>
  )
}
