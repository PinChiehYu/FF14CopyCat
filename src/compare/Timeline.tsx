import { useEffect, useRef, useState } from 'react'
import type { Alignment, TimedCast } from '../analysis/alignment'
import { formatFightTime } from '../analysis/timeline'
import { abilityIconUrl } from '../fflogs/report'
import type { Ability } from '../fflogs/types'
import type { JobModule } from '../jobs'
import type { SideData } from './load'

const ZOOM_LEVELS = [10, 20, 40, 80] // 每秒像素

interface Lane {
  label: string
  side: 'mine' | 'ref'
  casts: { t: number; original: number; abilityId: number }[]
}

function lanes(side: SideData, label: string, key: Lane['side'], job: JobModule | undefined, map: (t: number) => number): Lane[] {
  const casts = side.playerCasts.map((c) => ({ t: map(c.t), original: c.t, abilityId: c.abilityId }))
  if (!job) return [{ label, side: key, casts }]
  return [
    { label: `${label} GCD`, side: key, casts: casts.filter((c) => job.isGcd(c.abilityId)) },
    { label: `${label} oGCD`, side: key, casts: casts.filter((c) => !job.isGcd(c.abilityId)) },
  ]
}

function dedupeBoss(casts: TimedCast[]): TimedCast[] {
  const last = new Map<number, number>()
  return casts.filter((c) => {
    const prev = last.get(c.abilityId)
    if (prev !== undefined && c.t - prev < 1000) return false
    last.set(c.abilityId, c.t)
    return true
  })
}

export function Timeline({
  mine,
  reference: ref,
  alignment,
  abilities,
  job,
  highlights = [],
  focus = null,
}: {
  mine: SideData
  reference: SideData
  alignment: Alignment
  abilities: Map<number, Ability>
  job: JobModule | undefined
  /** 以參考時間標示的區段（例如少打 GCD 的時段），畫在我的列上 */
  highlights?: { start: number; end: number }[]
  /** 要捲動到的參考時間；每次傳入新物件就會捲動一次 */
  focus?: { t: number } | null
}) {
  const [pxPerSec, setPxPerSec] = useState(20)
  const x = (ms: number) => (ms / 1000) * pxPerSec
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!focus || !scrollRef.current) return
    scrollRef.current.scrollTo({ left: Math.max(0, (focus.t / 1000) * pxPerSec - 120), behavior: 'smooth' })
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    // 只在 focus 改變時捲動；縮放時不重捲
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  const mineEnd = alignment.mineToRef(mine.duration)
  const totalMs = Math.max(ref.duration, mineEnd)
  const width = x(totalMs) + 40
  const anchorRefTimes = new Set(alignment.anchors.map((a) => a.ref))

  const allLanes = [
    ...lanes(ref, '參考', 'ref', job, (t) => t),
    ...lanes(mine, '我', 'mine', job, alignment.mineToRef),
  ]
  const name = (id: number) => abilities.get(id)?.name ?? `#${id}`
  const ticks = Array.from({ length: Math.floor(totalMs / 10_000) + 1 }, (_, i) => i * 10_000)

  return (
    <div className="timeline" ref={rootRef}>
      <div className="timeline-toolbar">
        <label>
          縮放
          <select value={pxPerSec} onChange={(e) => setPxPerSec(Number(e.target.value))}>
            {ZOOM_LEVELS.map((z) => (
              <option key={z} value={z}>
                {z} px/秒
              </option>
            ))}
          </select>
        </label>
        <span className="hint">時間軸以參考日誌為準；我的施放已依 Boss 機制對齊。滑鼠停在圖示上可看技能與原始時間。</span>
      </div>

      <div className="timeline-body">
        <div className="timeline-labels">
          <div className="lane-label ruler-label">時間</div>
          <div className="lane-label">Boss（參考）</div>
          {allLanes.map((lane) => (
            <div key={lane.label} className={`lane-label ${lane.side}`}>
              {lane.label}
            </div>
          ))}
        </div>

        <div className="timeline-scroll" ref={scrollRef}>
          <div className="timeline-canvas" style={{ width }}>
            <div className="lane ruler">
              {ticks.map((t) => (
                <span key={t} className="tick" style={{ left: x(t) }}>
                  {formatFightTime(t).replace(/\.\d$/, '')}
                </span>
              ))}
            </div>

            <div className="lane boss">
              {dedupeBoss(ref.bossCasts).map((c, i) => (
                <span
                  key={i}
                  className={anchorRefTimes.has(c.t) ? 'boss-cast anchor' : 'boss-cast'}
                  style={{ left: x(c.t) }}
                  title={`${name(c.abilityId)} ${formatFightTime(c.t)}${anchorRefTimes.has(c.t) ? '（對齊錨點）' : ''}`}
                />
              ))}
            </div>

            {allLanes.map((lane) => (
              <div key={lane.label} className={`lane ${lane.side}`}>
                {lane.side === 'mine' &&
                  highlights.map((h) => (
                    <span
                      key={h.start}
                      className="highlight"
                      style={{ left: x(h.start), width: x(h.end - h.start) }}
                      title="少打 GCD 的時段"
                    />
                  ))}
                {lane.casts.map((c, i) => {
                  const ability = abilities.get(c.abilityId)
                  const time =
                    lane.side === 'mine'
                      ? `${formatFightTime(c.original)}（對齊後 ${formatFightTime(c.t)}）`
                      : formatFightTime(c.t)
                  return ability ? (
                    <img
                      key={i}
                      className="cast"
                      src={abilityIconUrl(ability.icon)}
                      alt={ability.name}
                      title={`${ability.name} ${time}`}
                      loading="lazy"
                      style={{ left: x(c.t) }}
                    />
                  ) : (
                    <span key={i} className="cast unknown" title={`${name(c.abilityId)} ${time}`} style={{ left: x(c.t) }} />
                  )
                })}
                {lane.side === 'mine' && mine.duration < ref.duration && (
                  <span className="end-marker" style={{ left: x(mineEnd) }} title="我的戰鬥結束" />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
