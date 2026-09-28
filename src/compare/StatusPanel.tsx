import type { TimedCast } from '../analysis/alignment'
import { aurasAt, hpAt, type Aura } from '../analysis/buffs'
import { controlNames } from '../analysis/control'
import { formatFightTime } from '../analysis/timeline'
import { abilityIconUrl, isPenaltyStatusName } from '../fflogs/report'
import type { Ability } from '../fflogs/types'
import { deathAt, type CastBar, type SideData } from './load'
import type { ReactNode } from 'react'

// Boss 施放：顯示游標前後這段時間內的
const BOSS_WINDOW_MS = 5000
// 最近使用的技能：顯示這段時間內的，最多幾組（一組＝一個 GCD 與其後穿插的能力技）；前 RECENT_SOLID_MS 不淡化
const RECENT_MS = 8000
const RECENT_SOLID_MS = 4000
const MAX_RECENT_GROUPS = 4
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

/** Boss 控場：取代讀條的位置（控場期間無法詠唱），顯示控場效果與剩餘秒數，進度隨時間減少。 */
function ControlBarView({ start, end, t, name }: { start: number; end: number; t: number; name: string }) {
  const remaining = Math.max(0, 1 - (t - start) / Math.max(1, end - start))
  return (
    <div className="cast-bar control" title={`Boss 控場：${name}，期間無法施放`}>
      <span className="cast-bar-fill" style={{ width: `${remaining * 100}%` }} />
      <span className="cast-bar-text">
        控場：{name}
        <span className="cast-bar-time">{((end - t) / 1000).toFixed(1)}s</span>
      </span>
    </div>
  )
}

/** 最近使用的技能：由新到舊，越舊越淡。 */
/**
 * 最近使用的技能，以 GCD 分組：每組是一個 GCD（大圖示）與其後穿插的能力技（小圖示），由新到舊排列，
 * 看得出「GCD → 插了幾個能力技 → 下一個 GCD」。最新的一個加框；前 RECENT_SOLID_MS 不淡化，之後越舊越淡。
 */
function RecentActions({
  side,
  t,
  abilities,
  abilityName,
  isGcd,
}: {
  side: SideData
  t: number
  abilities: Map<number, Ability>
  abilityName: (id: number) => string
  isGcd: (abilityId: number) => boolean
}) {
  const recent = side.playerCasts.filter((c) => c.t <= t && c.t > t - RECENT_MS)
  // 由舊到新分組：GCD 開新的一組，能力技加進目前這組（窗口開頭的能力技自成一組、沒有 GCD）
  const groups: { gcd: (typeof recent)[number] | null; weaves: typeof recent }[] = []
  for (const c of recent) {
    if (isGcd(c.abilityId)) groups.push({ gcd: c, weaves: [] })
    else if (groups.length > 0) groups.at(-1)!.weaves.push(c)
    else groups.push({ gcd: null, weaves: [c] })
  }
  const shown = groups.slice(-MAX_RECENT_GROUPS).reverse()
  const newest = recent.at(-1)
  const icon = (c: (typeof recent)[number], kind: 'gcd' | 'ogcd') => {
    const ability = abilities.get(c.abilityId)
    const age = t - c.t
    const title = `${abilityName(c.abilityId)}（${kind === 'gcd' ? 'GCD' : '能力技'}，${(age / 1000).toFixed(1)} 秒前）`
    const fade = Math.max(0, (age - RECENT_SOLID_MS) / (RECENT_MS - RECENT_SOLID_MS))
    const style = { opacity: 1 - fade * 0.65 }
    const className = `recent-action ${kind}${c === newest ? ' newest' : ''}`
    return ability?.icon ? (
      <img key={`${c.t}-${c.abilityId}`} className={className} src={abilityIconUrl(ability.icon)} alt={title} title={title} style={style} />
    ) : (
      <span key={`${c.t}-${c.abilityId}`} className={`${className} aura-text`} title={title} style={style}>
        {abilityName(c.abilityId).slice(0, 2)}
      </span>
    )
  }
  return (
    <div className="recent-actions" aria-label="最近使用的技能（由左到右由新到舊；大圖示為 GCD，左邊的小圖示為之後穿插的能力技）">
      {shown.map((g) => (
        <span key={`${(g.gcd ?? g.weaves[0]).t}`} className="recent-group">
          {/* 整列由左到右是由新到舊：組內也一樣，GCD 之後才按的能力技放在 GCD 左邊（新的在左） */}
          {[...g.weaves].reverse().map((c) => icon(c, 'ogcd'))}
          {g.gcd && icon(g.gcd, 'gcd')}
        </span>
      ))}
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
  control,
  namedStatus,
  isGcd,
}: {
  label: string
  side: SideData
  /** Boss 控場的效果 ID（見 control.ts） */
  control: Set<number>
  namedStatus: (id: number) => boolean
  /** 這一側的戰鬥時間 */
  t: number
  /** 標題旁顯示的時間（與播放列不同時才傳） */
  time?: number
  abilities: Map<number, Ability>
  abilityName: (id: number) => string
  isGcd: (abilityId: number) => boolean
}) {
  const hp = hpAt(side.hp, t)
  const pct = hp ? Math.round((hp.hp / hp.maxHp) * 100) : null
  const player = side.selection.player
  // 只列角色自己的 Buff（學習重點）；隊友給的 Buff 與敵人給的 Debuff 不顯示
  // 剩餘時間短的在前（爆發期的 Buff 是學習重點）；一行放不下時截掉的是右邊剩餘時間長的（進食、坦姿等）
  const buffs = aurasAt(side.auras, t)
    .filter((a) => a.sourceId === player.id && !a.debuff)
    .sort((a, b) => a.end - b.end)
  // 詠唱中的技能；被取消的詠唱在取消後短暫保留，讓播放時看得到
  const casting = side.castBars.find((b) => b.start <= t && (t < b.end || (b.interrupted && t < b.end + CANCELLED_SHOW_MS)))
  const icon = (a: Aura) => (
    <AuraIcon key={a.statusId} aura={a} t={t} ability={abilities.get(a.statusId)} name={abilityName(a.statusId)} />
  )
  const dead = deathAt(side.deaths, t)
  // 讓輸出下降的懲罰效果（傷害降低、衰弱、瀕死）：外框高光並在標題列顯示
  const penalties = side.bossDebuffs.filter((d) => {
    if (d.start > t || t >= d.end) return false
    const ability = abilities.get(d.statusId)
    return isPenaltyStatusName(ability?.englishName ?? ability?.name ?? '')
  })
  const penaltyText = (d: (typeof penalties)[number]) =>
    `${abilityName(d.statusId)}${d.openEnded ? '' : ` ${Math.ceil((d.end - t) / 1000)}s`}`
  // 這一側當下的 Boss 控場（兩邊各自的時間，可能不同）
  const controls = side.bossDebuffs.filter((d) => control.has(d.statusId) && d.start <= t && t < d.end)
  const controlBar =
    controls.length === 0
      ? null
      : {
          start: Math.min(...controls.map((d) => d.start)),
          end: Math.max(...controls.map((d) => d.end)),
          name: controlNames(controls.map((d) => d.statusId).filter(namedStatus), abilityName),
        }
  return (
    <div className={`side-status${dead ? ' dead' : penalties.length > 0 ? ' penalized' : ''}`}>
      <div className="side-status-head">
        <span className={label === '我' ? 'mine' : 'ref'}>{label}</span>
        {/* 懲罰效果（死亡時由死亡標示）；單行截斷，完整內容在滑鼠提示 */}
        {!dead && penalties.length > 0 && (
          <span className="penalty-badge" title={`讓輸出下降的效果：\n${penalties.map(penaltyText).join('\n')}`}>
            ▼ {penalties.map(penaltyText).join('、')}
          </span>
        )}
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
      {controlBar ? (
        <ControlBarView start={controlBar.start} end={controlBar.end} t={t} name={controlBar.name} />
      ) : casting ? (
        <CastBarView bar={casting} t={t} name={abilityName(casting.abilityId)} />
      ) : (
        <div className="cast-bar idle" />
      )}
      <RecentActions side={side} t={t} abilities={abilities} abilityName={abilityName} isGcd={isGcd} />
      <div className="aura-row">{buffs.length > 0 ? buffs.map(icon) : <span className="hint-inline">沒有自身 Buff</span>}</div>
    </div>
  )
}

/** Boss 最近與即將施放的技能（單行：名稱過長時截斷，完整內容在滑鼠提示）。casts 與 t 為同一場的戰鬥時間。 */
function BossNow({
  label,
  casts,
  t,
  abilityName,
}: {
  label: ReactNode
  casts: TimedCast[]
  t: number
  abilityName: (id: number) => string
}) {
  const recent = casts.filter((c) => c.t <= t && c.t > t - BOSS_WINDOW_MS).at(-1)
  const upcoming = casts.find((c) => c.t > t && c.t <= t + BOSS_WINDOW_MS)
  return (
    <p
      className="boss-now"
      title={[
        recent && `${abilityName(recent.abilityId)}（${((t - recent.t) / 1000).toFixed(1)} 秒前）`,
        upcoming && `接著：${abilityName(upcoming.abilityId)}（${((upcoming.t - t) / 1000).toFixed(1)} 秒後）`,
      ]
        .filter(Boolean)
        .join('\n')}
    >
      {label}
      {recent ? (
        <>
          <span className="boss-now-name">{abilityName(recent.abilityId)}</span>
          <span className="boss-now-time">{((t - recent.t) / 1000).toFixed(1)}s 前</span>
        </>
      ) : (
        <span className="boss-now-name">—</span>
      )}
      {upcoming && (
        <>
          <span className="boss-now-next">→</span>
          <span className="boss-now-name next">{abilityName(upcoming.abilityId)}</span>
          <span className="boss-now-time">{((upcoming.t - t) / 1000).toFixed(1)}s 後</span>
        </>
      )}
    </p>
  )
}

/**
 * 游標時間點上，兩邊玩家的血量與自身 Buff，以及兩場 Boss 最近與即將施放的技能。
 * Boss 固定兩行（我的、參考，各自依自己的戰鬥時間），不隨俯視圖的視角改變行數，播放與切換視角時版面不跳動。
 * 還沒有參考日誌時（reference 為 null）只列我的 Boss 與我。
 */
export function StatusPanel({
  mine,
  reference,
  cursor,
  refToMine,
  abilities,
  abilityName,
  control,
  namedStatus,
  isGcd,
}: {
  mine: SideData
  reference: SideData | null
  /** 參考時間 */
  cursor: number
  refToMine: (t: number) => number
  abilities: Map<number, Ability>
  abilityName: (id: number) => string
  control: Set<number>
  namedStatus: (id: number) => boolean
  /** 職業的 GCD 判斷（最近使用的技能分組用） */
  isGcd: (abilityId: number) => boolean
}) {
  const mineT = refToMine(cursor)
  return (
    <div className="status-panel">
      <div className="boss-now-pair">
        <BossNow
          label={<span className="legend boss mine">◯ {reference ? '我的 Boss' : 'Boss'}</span>}
          casts={mine.bossCasts}
          t={mineT}
          abilityName={abilityName}
        />
        {reference && (
          <BossNow
            label={<span className="legend boss ref">◯ 參考 Boss</span>}
            casts={reference.bossCasts}
            t={cursor}
            abilityName={abilityName}
          />
        )}
      </div>
      <SideStatus
        label="我"
        side={mine}
        t={mineT}
        time={Math.abs(mineT - cursor) >= 100 ? mineT : undefined}
        abilities={abilities}
        abilityName={abilityName}
        control={control}
        namedStatus={namedStatus}
        isGcd={isGcd}
      />
      {reference && (
        <SideStatus
          label="參考"
          side={reference}
          t={cursor}
          abilities={abilities}
          abilityName={abilityName}
          control={control}
          namedStatus={namedStatus}
          isGcd={isGcd}
        />
      )}
    </div>
  )
}
