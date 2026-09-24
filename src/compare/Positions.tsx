import { MIRROR_LABELS, type Divergence, type Point, type PositionSample, type TrackPoint } from '../analysis/positions'
import { formatFightTime } from '../analysis/timeline'

// 地圖上顯示游標前多久的移動軌跡
const TRAIL_MS = 5000
const MAP_SIZE = 360
const CHART_WIDTH = 1000
const CHART_HEIGHT = 90

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
          className={d.mirror ? 'band mirrored' : 'band'}
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
  track,
  divergences,
  mineSamples,
  refSamples,
  threshold,
  duration,
  cursor,
  onSeek,
  onJump,
}: {
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

  return (
    <section className="positions">
      <p>
        兩人距離持續超過 {threshold} yalm 的時段共 {divergences.length} 段
        {divergences.some((d) => d.mirror) && `，其中 ${divergences.filter((d) => d.mirror).length} 段可能是對稱站位（不同攻略）`}
        。站位差異僅供參考，不同攻略或分配的站位本來就可能不同。
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
          <input
            type="range"
            className="scrubber"
            min={0}
            max={duration}
            step={500}
            value={cursor}
            onChange={(e) => onSeek(Number(e.target.value))}
            aria-label="時間"
          />
          <p className="arena-caption">
            <span className="legend mine">● 我</span> <span className="legend ref">● 參考</span>{' '}
            <span className="legend boss">● Boss</span>　{formatFightTime(cursor)}
            {now?.distance != null && `　距離 ${now.distance.toFixed(1)} yalm`}
          </p>
        </div>
        <ul className="divergence-list">
          {divergences.map((d) => (
            <li key={d.start}>
              <button type="button" onClick={() => onJump(d.start)}>
                {formatFightTime(d.start)}–{formatFightTime(d.end)}
              </button>{' '}
              最遠 {d.maxDistance.toFixed(1)} yalm
              {d.mirror && <span className="tag">可能是{MIRROR_LABELS[d.mirror]}站位</span>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
