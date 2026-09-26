import {
  distanceAt,
  MIRROR_LABELS,
  type Divergence,
  type Point,
  type PositionSample,
  type TrackPoint,
} from '../analysis/positions'
import type { ReactNode } from 'react'
import { formatFightTime } from '../analysis/timeline'

// 地圖上顯示游標前多久的移動軌跡
const TRAIL_MS = 5000
const MAP_SIZE = 360
const CHART_WIDTH = 1000
const CHART_HEIGHT = 90
// 每段站位差異最多列出幾個機制
const MAX_LISTED_MECHANICS = 3

function nearest(track: TrackPoint[], t: number): TrackPoint | undefined {
  if (track.length === 0) return undefined
  const step = track.length > 1 ? track[1].t - track[0].t : 1
  return track[Math.min(track.length - 1, Math.max(0, Math.round(t / step)))]
}

function bounds(samples: PositionSample[][]): { minX: number; minY: number; size: number } {
  const all = samples.flat()
  if (all.length === 0) return { minX: 80, minY: 80, size: 40 }
  const xs = all.map((p) => p.x)
  const ys = all.map((p) => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  // 正方形、留邊
  const size = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY, 20) + 6
  return { minX: minX - 3, minY: minY - 3, size }
}

function Arena({
  track,
  cursor,
  mineSamples,
  refSamples,
}: {
  track: TrackPoint[]
  cursor: number
  mineSamples: PositionSample[]
  refSamples: PositionSample[]
}) {
  const { minX, minY, size } = bounds([mineSamples, refSamples])
  const scale = MAP_SIZE / size
  const px = (p: Point) => ({ x: (p.x - minX) * scale, y: (p.y - minY) * scale })
  const trail = (key: 'mine' | 'ref') =>
    track
      .filter((p) => p.t > cursor - TRAIL_MS && p.t <= cursor && p[key])
      .map((p) => px(p[key]!))
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ')
  const now = nearest(track, cursor)
  // 每 5 yalm 一條格線
  const grid = Array.from({ length: Math.ceil(size / 5) + 1 }, (_, i) => Math.ceil(minX / 5) * 5 + i * 5)
  const gridY = Array.from({ length: Math.ceil(size / 5) + 1 }, (_, i) => Math.ceil(minY / 5) * 5 + i * 5)

  return (
    <svg className="arena" viewBox={`0 0 ${MAP_SIZE} ${MAP_SIZE}`} role="img" aria-label="俯視站位圖">
      {grid.map((gx) => (
        <line key={`x${gx}`} className="grid" x1={(gx - minX) * scale} x2={(gx - minX) * scale} y1={0} y2={MAP_SIZE} />
      ))}
      {gridY.map((gy) => (
        <line key={`y${gy}`} className="grid" y1={(gy - minY) * scale} y2={(gy - minY) * scale} x1={0} x2={MAP_SIZE} />
      ))}
      <polyline className="trail ref" points={trail('ref')} />
      <polyline className="trail mine" points={trail('mine')} />
      {now?.boss && <circle className="boss-dot" cx={px(now.boss).x} cy={px(now.boss).y} r={9} />}
      {now?.ref && <circle className="dot ref" cx={px(now.ref).x} cy={px(now.ref).y} r={6} />}
      {now?.mine && <circle className="dot mine" cx={px(now.mine).x} cy={px(now.mine).y} r={6} />}
      <text className="north" x={MAP_SIZE - 14} y={16}>
        N
      </text>
    </svg>
  )
}

function DistanceChart({
  track,
  divergences,
  cursor,
  threshold,
  duration,
  onSeek,
}: {
  track: TrackPoint[]
  divergences: Divergence[]
  cursor: number
  threshold: number
  duration: number
  onSeek: (t: number) => void
}) {
  const maxD = Math.max(threshold * 2, ...track.map((p) => p.distance ?? 0))
  const x = (t: number) => (t / duration) * CHART_WIDTH
  const y = (d: number) => CHART_HEIGHT - (d / maxD) * (CHART_HEIGHT - 4)
  // 沒有資料的點斷開折線
  const path = track
    .map((p, i) => {
      if (p.distance === null) return ''
      const prev = track[i - 1]
      const cmd = prev && prev.distance !== null ? 'L' : 'M'
      return `${cmd}${x(p.t).toFixed(1)},${y(p.distance).toFixed(1)}`
    })
    .join('')

  return (
    <svg
      className="distance-chart"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      preserveAspectRatio="none"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        onSeek(((e.clientX - rect.left) / rect.width) * duration)
      }}
    >
      {divergences.map((d) => (
        <rect
          key={d.start}
          className={d.mirror ? 'band mirrored' : d.mechanics.length > 0 ? 'band mechanic' : 'band'}
          x={x(d.start)}
          width={Math.max(2, x(d.end) - x(d.start))}
          y={0}
          height={CHART_HEIGHT}
        />
      ))}
      <line className="threshold" x1={0} x2={CHART_WIDTH} y1={y(threshold)} y2={y(threshold)} />
      <path className="distance-line" d={path} vectorEffect="non-scaling-stroke" />
      <line className="cursor" x1={x(cursor)} x2={x(cursor)} y1={0} y2={CHART_HEIGHT} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function Positions({
  abilityName,
  track,
  divergences,
  mineSamples,
  refSamples,
  threshold,
  duration,
  cursor,
  onSeek,
  onJump,
  status,
}: {
  /** 顯示在站位圖旁的當下狀態（血量、Buff） */
  status?: ReactNode
  abilityName: (id: number) => string
  track: TrackPoint[]
  divergences: Divergence[]
  /** 已換算成參考時間 */
  mineSamples: PositionSample[]
  refSamples: PositionSample[]
  threshold: number
  duration: number
  cursor: number
  /** 只移動游標（拖曳、點圖表） */
  onSeek: (t: number) => void
  /** 移動游標並捲動時間軸（點清單） */
  onJump: (t: number) => void
}) {
  const now = nearest(track, cursor)
  const hasData = track.some((p) => p.distance !== null)
  if (!hasData) return <p className="hint">這兩份日誌沒有足夠的位置資料。</p>
  const atMechanic = divergences.filter((d) => d.mechanics.length > 0).length
  const mirrored = divergences.filter((d) => d.mirror).length
  // 同一段內重複的機制名稱只列一次，最多列 3 個；附上機制結算當下兩人的距離
  const mechanicLabel = (d: Divergence) => {
    const seen = new Set<string>()
    const unique = d.mechanics
      .map((m) => ({ name: abilityName(m.abilityId), t: m.t }))
      .filter((m) => !seen.has(m.name) && seen.add(m.name))
    const listed = unique.slice(0, MAX_LISTED_MECHANICS).map((m) => {
      const distance = distanceAt(track, m.t)
      return `${m.name}（${formatFightTime(m.t)}${distance != null ? `，相距 ${distance.toFixed(1)} yalm` : ''}）`
    })
    const more = unique.length > MAX_LISTED_MECHANICS ? ` 等 ${unique.length} 個` : ''
    return listed.join('、') + more
  }

  return (
    <section className="positions">
      <p>
        兩人距離持續超過 {threshold} yalm 的時段共 {divergences.length} 段，其中{' '}
        <strong>{atMechanic} 段在 Boss 機制結算時仍站在不同位置</strong>（以「機制」標示，最值得對照）
        {mirrored > 0 && `，${mirrored} 段可能是對稱站位（不同攻略）`}
        。站位差異在機制結算時才有明顯意義；其餘多半只是移動路線不同。
      </p>
      <DistanceChart
        track={track}
        divergences={divergences}
        cursor={cursor}
        threshold={threshold}
        duration={duration}
        onSeek={onSeek}
      />
      <div className="positions-body">
        <div className="arena-panel">
          <Arena track={track} cursor={cursor} mineSamples={mineSamples} refSamples={refSamples} />
          <p className="arena-caption">
            <span className="legend mine">● 我</span> <span className="legend ref">● 參考</span>{' '}
            <span className="legend boss">● Boss</span>　{formatFightTime(cursor)}
            {now?.distance != null && `　距離 ${now.distance.toFixed(1)} yalm`}
          </p>
        </div>
        {status}
        <ul className="divergence-list">
          {divergences.map((d) => (
            <li key={d.start} className={d.mechanics.length > 0 ? 'at-mechanic' : undefined}>
              <button type="button" onClick={() => onJump(d.start)}>
                {formatFightTime(d.start)}–{formatFightTime(d.end)}
              </button>{' '}
              最遠 {d.maxDistance.toFixed(1)} yalm
              {d.mirror && <span className="tag">可能是{MIRROR_LABELS[d.mirror]}站位</span>}
              {d.mechanics.length > 0 && (
                <div className="mechanic-note">
                  <span className="tag mechanic">機制</span>
                  {mechanicLabel(d)}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
