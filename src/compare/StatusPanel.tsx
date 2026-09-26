import type { TimedCast } from '../analysis/alignment'
import { aurasAt, hpAt, type Aura } from '../analysis/buffs'
import { formatFightTime } from '../analysis/timeline'
import { abilityIconUrl } from '../fflogs/report'
import type { Ability } from '../fflogs/types'
import { deathAt, type CastBar, type SideData } from './load'

// Boss 施放：顯示游標前後這段時間內的
const BOSS_WINDOW_MS = 5000
// 最近使用的技能：顯示這段時間內的，最多幾個
const RECENT_MS = 4000
const MAX_RECENT = 6
// 被取消的詠唱在取消後保留顯示的時間
const CANCELLED_SHOW_MS = 600

/** 讀條：詠唱中的技能名稱、進度與剩餘秒數（被取消的詠唱以灰色顯示）。 */
function CastBarView({ bar, t, name }: { bar: CastBar; t: number; name: string }) {
  const progress = Math.min(1, (t - bar.start) / Math.max(1, bar.end - bar.start))
  return (
    <div className={`cast-bar${bar.interrupted ? ' interrupted' : ''}`} title={bar.interrupted ? `${name}（詠唱被取消）` : name}>
      <span className="cast-bar-fill" style={{ width: `${progress * 100}%` }} />
      <span className="cast-bar-text">
        {name}
        <span className="cast-bar-time">{bar.interrupted ? '取消' : `${((bar.end - t) / 1000).toFixed(1)}s`}</span>
      </span>
    </div>
  )
}

/** 最近使用的技能：由新到舊，越舊越淡。 */
function RecentActions({ side, t, abilities, abilityName }: { side: SideData; t: number; abilities: Map<number, Ability>; abilityName: (id: number) => string }) {
  const recent = side.playerCasts
    .filter((c) => c.t <= t && c.t > t - RECENT_MS)
    .slice(-MAX_RECENT)
    .reverse()
  return (
    <div className="recent-actions" aria-label="最近使用的技能">
      {recent.map((c) => {
        const ability = abilities.get(c.abilityId)
        const age = t - c.t
        const title = `${abilityName(c.abilityId)}（${(age / 1000).toFixed(1)} 秒前）`
        const style = { opacity: 1 - (age / RECENT_MS) * 0.7 }
        return ability?.icon ? (
          <img key={`${c.t}-${c.abilityId}`} className="recent-action" src={abilityIconUrl(ability.icon)} alt={title} title={title} style={style} />
        ) : (
          <span key={`${c.t}-${c.abilityId}`} className="recent-action aura-text" title={title} style={style}>
            {abilityName(c.abilityId).slice(0, 2)}
          </span>
        )
      })}
    </div>
  )
}

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
  time,
}: {
  label: string
  side: SideData
  /** 這一側的戰鬥時間 */
  t: number
  /** 標題旁顯示的時間（與播放列不同時才傳） */
  time?: number
  abilities: Map<number, Ability>
  abilityName: (id: number) => string
}) {
  const hp = hpAt(side.hp, t)
  const pct = hp ? Math.round((hp.hp / hp.maxHp) * 100) : null
  const player = side.selection.player
  // 只列角色自己的 Buff（學習重點）；隊友給的 Buff 與敵人給的 Debuff 不顯示
  const buffs = aurasAt(side.auras, t).filter((a) => a.sourceId === player.id && !a.debuff)
  // 詠唱中的技能；被取消的詠唱在取消後短暫保留，讓播放時看得到
  const casting = side.castBars.find((b) => b.start <= t && (t < b.end || (b.interrupted && t < b.end + CANCELLED_SHOW_MS)))
  const icon = (a: Aura) => (
    <AuraIcon key={a.statusId} aura={a} t={t} ability={abilities.get(a.statusId)} name={abilityName(a.statusId)} />
  )
  const dead = deathAt(side.deaths, t)
  return (
    <div className={`side-status${dead ? ' dead' : ''}`}>
      <div className="side-status-head">
        <span className={label === '我' ? 'mine' : 'ref'}>{label}</span>
        {/* 參考的時間就是播放列的時間；只有我的（對齊前的原始時間）不同才顯示 */}
        {time !== undefined && (
          <span className="hint-inline" title="你的日誌中的原始時間">
            {formatFightTime(Math.max(0, time))}
          </span>
        )}
      </div>
      {dead && (
        <div className="dead-badge">
          ✕ 死亡{dead.abilityId !== null && `（被「${abilityName(dead.abilityId)}」擊殺）`}
        </div>
      )}
      <div className="hp-bar" title={hp ? `${hp.hp.toLocaleString()} / ${hp.maxHp.toLocaleString()}` : '沒有血量資料'}>
        <span className="hp-fill" style={{ width: `${pct ?? 0}%` }} />
        {hp && hp.absorb > 0 && <span className="hp-shield" style={{ width: `${Math.min(100, hp.absorb)}%` }} />}
        <span className="hp-text">{pct === null ? '—' : `${pct}%`}</span>
      </div>
      {casting ? <CastBarView bar={casting} t={t} name={abilityName(casting.abilityId)} /> : <div className="cast-bar idle" />}
      <RecentActions side={side} t={t} abilities={abilities} abilityName={abilityName} />
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
  const mineT = refToMine(cursor)
  return (
    <div className="status-panel">
      <p className="boss-now">
        <span className="legend boss">● Boss</span>{' '}
        {recent ? `${abilityName(recent.abilityId)}（${((cursor - recent.t) / 1000).toFixed(1)} 秒前）` : '—'}
        {upcoming && <span className="hint-inline">　接著：{abilityName(upcoming.abilityId)}（{((upcoming.t - cursor) / 1000).toFixed(1)} 秒後）</span>}
      </p>
      <SideStatus
        label="我"
        side={mine}
        t={mineT}
        time={Math.abs(mineT - cursor) >= 100 ? mineT : undefined}
        abilities={abilities}
        abilityName={abilityName}
      />
      <SideStatus label="參考" side={reference} t={cursor} abilities={abilities} abilityName={abilityName} />
    </div>
  )
}
