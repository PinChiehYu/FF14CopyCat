import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { pushTitle, type Alignment, type PushDifference, type TimedCast } from '../analysis/alignment'
import { formatFightTime } from '../analysis/timeline'
import { abilityIconUrl } from '../fflogs/report'
import type { Ability } from '../fflogs/types'
import type { JobModule } from '../jobs'
import type { SideData } from './load'
import type { TimelineWindow } from '../analysis/windows'

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
  windows = [],
  pushes = [],
  focus = null,
  cursor,
  follow = false,
  onSeek,
  compareEnd,
}: {
  mine: SideData
  reference: SideData
  alignment: Alignment
  abilities: Map<number, Ability>
  job: JobModule | undefined
  /** 以參考時間標示的區段（例如少打 GCD 的時段），畫在我的列上 */
  highlights?: { start: number; end: number }[]
  /** 技能窗口（各側自己的戰鬥時間），畫在該側 GCD 列的底部 */
  windows?: (TimelineWindow & { side: 'mine' | 'ref' })[]
  /** 推進差距（例如轉場），標在 Boss 列上 */
  pushes?: PushDifference[]
  /** 要捲動到的參考時間；每次傳入新物件就會捲動一次 */
  focus?: { t: number } | null
  /** 目前檢視的參考時間，畫成直線 */
  cursor?: number
  /** 播放中：游標超出可見範圍時自動捲動 */
  follow?: boolean
  /** 點擊時間尺時移動游標 */
  onSeek?: (t: number) => void
  /** 比較範圍結束（參考時間）；之後的部分標示為範圍外 */
  compareEnd?: number
}) {
  const [pxPerSec, setPxPerSec] = useState(20)
  const x = (ms: number) => (ms / 1000) * pxPerSec
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!focus || !scrollRef.current) return
    // 內層立即捲動：同時對外層做平滑捲動時，瀏覽器會中斷內層的平滑捲動
    scrollRef.current.scrollLeft = Math.max(0, (focus.t / 1000) * pxPerSec - 120)
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    // 只在 focus 改變時捲動；縮放時不重捲
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  // 播放中讓游標保持在可見範圍（游標接近右緣時往後捲，停在左側四分之一處）
  useEffect(() => {
    const el = scrollRef.current
    if (!follow || cursor === undefined || !el) return
    const cx = (cursor / 1000) * pxPerSec
    if (cx < el.scrollLeft + 40 || cx > el.scrollLeft + el.clientWidth - 80) {
      el.scrollLeft = Math.max(0, cx - el.clientWidth * 0.25)
    }
  }, [follow, cursor, pxPerSec])

  const mineEnd = alignment.mineToRef(mine.duration)
  const totalMs = Math.max(ref.duration, mineEnd)
  const width = x(totalMs) + 40

  const allLanes = useMemo(
    () => [...lanes(ref, '參考', 'ref', job, (t) => t), ...lanes(mine, '我', 'mine', job, alignment.mineToRef)],
    [ref, mine, job, alignment],
  )

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
            {cursor !== undefined && <span className="timeline-cursor" style={{ left: x(cursor) }} />}
            {compareEnd !== undefined && totalMs - compareEnd >= 1000 && (
              <span className="out-of-range" style={{ left: x(compareEnd) }} title="超出比較範圍：另一方的戰鬥已結束，不列入統計">
                比較範圍外
              </span>
            )}
            <TimelineLanes
              mine={mine}
              reference={ref}
              alignment={alignment}
              abilities={abilities}
              allLanes={allLanes}
              highlights={highlights}
              windows={windows}
              pushes={pushes}
              pxPerSec={pxPerSec}
              totalMs={totalMs}
              onSeek={onSeek}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/** 時間尺、Boss 列與玩家的技能列（不隨游標變動；播放時不重繪）。 */
function TimelineLanesImpl({
  mine,
  reference: ref,
  alignment,
  abilities,
  allLanes,
  highlights,
  windows,
  pushes,
  pxPerSec,
  totalMs,
  onSeek,
}: {
  mine: SideData
  reference: SideData
  alignment: Alignment
  abilities: Map<number, Ability>
  allLanes: Lane[]
  highlights: { start: number; end: number }[]
  windows: (TimelineWindow & { side: 'mine' | 'ref' })[]
  pushes: PushDifference[]
  pxPerSec: number
  totalMs: number
  onSeek?: (t: number) => void
}) {
  const x = (ms: number) => (ms / 1000) * pxPerSec
  const mineEnd = alignment.mineToRef(mine.duration)
  const anchorRefTimes = new Set(alignment.anchors.map((a) => a.ref))
  const name = (id: number) => abilities.get(id)?.name ?? `#${id}`
  const ticks = Array.from({ length: Math.floor(totalMs / 10_000) + 1 }, (_, i) => i * 10_000)
  return (
    <>
            <div
              className="lane ruler"
              title="點擊以移動站位圖的時間"
              onClick={(e) => onSeek?.(((e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerSec) * 1000)}
            >
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
              {/* 推進差距：參考推進的時間點；我在這之前多花的時間被擠進這段 */}
              {pushes.map((p) => (
                <span
                  key={p.refEnd}
                  className={`push-marker ${p.deltaMs > 0 ? 'slower' : 'faster'}`}
                  style={{ left: x(p.refStart), minWidth: Math.max(4, x(p.refEnd - p.refStart)) }}
                  title={pushTitle(p)}
                >
                  我{p.deltaMs > 0 ? '慢' : '快'} {(Math.abs(p.deltaMs) / 1000).toFixed(1)} 秒
                </span>
              ))}
            </div>

            {allLanes.map((lane, laneIndex) => (
              <div key={lane.label} className={`lane ${lane.side}`}>
                {/* 技能窗口畫在每側的第一列（GCD 列）底部 */}
                {allLanes.findIndex((l) => l.side === lane.side) === laneIndex &&
                  windows
                    .filter((w) => w.side === lane.side)
                    .map((w) => {
                      const toRef = lane.side === 'mine' ? alignment.mineToRef : (t: number) => t
                      const start = toRef(w.start)
                      return (
                        <span
                          key={`${w.start}-${w.title}`}
                          className={`window-bar ${w.state}`}
                          style={{ left: x(start), width: Math.max(2, x(toRef(w.end) - start)) }}
                          title={w.title}
                        />
                      )
                    })}
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
                      title={`${ability.name}${ability.englishName ? `（${ability.englishName}）` : ''} ${time}`}
                      loading="lazy"
                      style={{ left: x(c.t) }}
                    />
                  ) : (
                    <span key={i} className="cast unknown" title={`${name(c.abilityId)} ${time}`} style={{ left: x(c.t) }} />
                  )
                })}
                {/* 死亡：每側第一列標 ✕，死亡到恢復行動之間畫斜線區段 */}
                {allLanes.findIndex((l) => l.side === lane.side) === laneIndex &&
                  (lane.side === 'mine' ? mine : ref).deaths.map((d) => {
                    const toRef = lane.side === 'mine' ? alignment.mineToRef : (t: number) => t
                    const side = lane.side === 'mine' ? mine : ref
                    const start = toRef(d.t)
                    const end = toRef(d.revivedAt ?? side.duration)
                    const cause = d.abilityId !== null ? `被「${name(d.abilityId)}」擊殺` : '死亡'
                    return (
                      <span key={`death-${d.t}`}>
                        <span className="dead-span" style={{ left: x(start), width: Math.max(2, x(end - start)) }} title={`死亡中（${cause}）`} />
                        <span className="death-marker" style={{ left: x(start) }} title={`${formatFightTime(d.t)} 死亡：${cause}`}>
                          ✕
                        </span>
                      </span>
                    )
                  })}
                {lane.side === 'mine' && mine.duration < ref.duration && (
                  <span className="end-marker" style={{ left: x(mineEnd) }} title="我的戰鬥結束" />
                )}
              </div>
            ))}
    </>
  )
}

const TimelineLanes = memo(TimelineLanesImpl)
