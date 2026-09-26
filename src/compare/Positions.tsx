import {
  distanceAt,
  MIRROR_LABELS,
  type Divergence,
  type Point,
  type PositionSample,
  type TrackPoint,
} from '../analysis/positions'
import { useEffect, useRef, type ReactNode } from 'react'
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

// Boss 位置取這個百分位範圍納入圖的範圍（排除轉場跳走等少數極端位置）
const BOSS_RANGE_QUANTILE = 0.05
// 邊緣箭頭離圖邊的距離
const EDGE_INSET = 12

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]
}

// 圖的範圍取游標前後這段時間內的位置：跟著目前的場地（M7S 等會換場的戰鬥，整場範圍會大到看不清楚）
const VIEW_WINDOW_MS = 10_000
// 圖至少涵蓋這麼大（yalm）
const MIN_VIEW_YALM = 30
// 範圍對齊到這個格距（yalm），播放時不會一直微幅縮放
const VIEW_STEP_YALM = 5

/**
 * 圖的範圍（正方形、置中）：游標前後 10 秒內兩位玩家的位置，加上 Boss 在這段時間大部分所在的位置
 * （排除少數極端位置）；這段時間沒有資料時以時間上最接近的資料為準。
 */
function bounds(players: PositionSample[][], boss: PositionSample[], cursor: number): { minX: number; minY: number; size: number } {
  const near = (s: PositionSample[], t: number) => s.filter((p) => Math.abs(p.t - t) <= VIEW_WINDOW_MS)
  let pts = players.flatMap((s) => near(s, cursor))
  let bossPts = near(boss, cursor)
  if (pts.length === 0 && bossPts.length === 0) {
    // 附近沒有資料（例如另一方的戰鬥已結束）：改以時間上最接近的資料為準
    const all = [...players.flat(), ...boss]
    if (all.length > 0) {
      const closest = all.reduce((a, b) => (Math.abs(b.t - cursor) < Math.abs(a.t - cursor) ? b : a)).t
      pts = players.flatMap((s) => near(s, closest))
      bossPts = near(boss, closest)
    }
  }
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  if (bossPts.length > 0) {
    const bx = bossPts.map((p) => p.x).sort((a, b) => a - b)
    const by = bossPts.map((p) => p.y).sort((a, b) => a - b)
    xs.push(quantile(bx, BOSS_RANGE_QUANTILE), quantile(bx, 1 - BOSS_RANGE_QUANTILE))
    ys.push(quantile(by, BOSS_RANGE_QUANTILE), quantile(by, 1 - BOSS_RANGE_QUANTILE))
  }
  if (xs.length === 0) return { minX: 80, minY: 80, size: 40 }
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const step = VIEW_STEP_YALM
  // 留邊後取 5 yalm 的倍數，中心也對齊 5 yalm
  const size = Math.ceil((Math.max(maxX - minX, maxY - minY, MIN_VIEW_YALM) + 6) / (step * 2)) * step * 2
  const cx = Math.round((minX + maxX) / 2 / step) * step
  const cy = Math.round((minY + maxY) / 2 / step) * step
  return { minX: cx - size / 2, minY: cy - size / 2, size }
}

/** Boss 在圖外時，在圖邊畫指向它的箭頭（從圖中心往 Boss 方向與內縮邊框的交點）。 */
function EdgeArrow({ target, label }: { target: Point; label: string }) {
  const c = MAP_SIZE / 2
  const dx = target.x - c
  const dy = target.y - c
  const half = c - EDGE_INSET
  const k = half / Math.max(Math.abs(dx), Math.abs(dy))
  const x = c + dx * k
  const y = c + dy * k
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI
  // 文字放在箭頭往圖內一點的位置，並夾在圖內
  const len = Math.hypot(dx, dy)
  const tx = Math.min(MAP_SIZE - 40, Math.max(40, x - (dx / len) * 26))
  const ty = Math.min(MAP_SIZE - 8, Math.max(14, y - (dy / len) * 22 + 4))
  return (
    <g className="edge-arrow">
      <polygon points="9,0 -6,-7 -6,7" transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle.toFixed(1)})`} />
      <text x={tx.toFixed(1)} y={ty.toFixed(1)} textAnchor="middle">
        {label}
      </text>
    </g>
  )
}

function Arena({
  track,
  cursor,
  mineSamples,
  refSamples,
  bossSamples,
}: {
  track: TrackPoint[]
  cursor: number
  mineSamples: PositionSample[]
  refSamples: PositionSample[]
  bossSamples: PositionSample[]
}) {
  const { minX, minY, size } = bounds([mineSamples, refSamples], bossSamples, cursor)
  const scale = MAP_SIZE / size
  const px = (p: Point) => ({ x: (p.x - minX) * scale, y: (p.y - minY) * scale })
  const trail = (key: 'mine' | 'ref') =>
    track
      .filter((p) => p.t > cursor - TRAIL_MS && p.t <= cursor && p[key])
      .map((p) => px(p[key]!))
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ')
  const now = nearest(track, cursor)
  const bossPx = now?.boss ? px(now.boss) : null
  const bossInside = bossPx !== null && bossPx.x >= 0 && bossPx.x <= MAP_SIZE && bossPx.y >= 0 && bossPx.y <= MAP_SIZE
  // 圖外的 Boss：標示離我多遠（沒有我的位置時用參考）
  const from = now?.mine ?? now?.ref
  const bossDistance =
    now?.boss && from ? `${Math.hypot(now.boss.x - from.x, now.boss.y - from.y).toFixed(0)} yalm` : ''
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
      {bossPx &&
        (bossInside ? (
          <circle className="boss-dot" cx={bossPx.x} cy={bossPx.y} r={9} />
        ) : (
          <EdgeArrow target={bossPx} label={`Boss ${bossDistance}`} />
        ))}
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
  bossSamples,
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
  /** 參考日誌的 Boss 位置（決定俯視圖的範圍） */
  bossSamples: PositionSample[]
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

  return (
    <section className="positions">
      {/* 一行摘要，說明放在滑鼠提示 */}
      <p className="positions-summary">
        <span title={`兩人相距超過 ${threshold} yalm、持續 2 秒以上的時段`}>
          站位差異 <strong>{divergences.length}</strong> 段
        </span>
        {atMechanic > 0 && (
          <span className="tag mechanic" title="Boss 機制結算時仍站在不同位置，最值得對照；其餘多半只是移動路線不同">
            機制 {atMechanic}
          </span>
        )}
        {mirrored > 0 && (
          <span className="tag" title="你的位置接近參考位置的對稱點，可能是攻略或分配不同">
            可能對稱 {mirrored}
          </span>
        )}
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
          <Arena track={track} cursor={cursor} mineSamples={mineSamples} refSamples={refSamples} bossSamples={bossSamples} />
          <p className="arena-caption">
            <span className="legend mine">● 我</span> <span className="legend ref">● 參考</span>{' '}
            <span className="legend boss" title={now?.boss ? undefined : '這個時間點沒有 Boss 的位置資料（Boss 無法選取、轉場等）'}>
              ● Boss{now?.boss ? '' : '（不在場）'}
            </span>
            {now?.distance != null && `　相距 ${now.distance.toFixed(1)} yalm`}
          </p>
        </div>
        {status}
      </div>
      <DivergenceCards divergences={divergences} track={track} cursor={cursor} abilityName={abilityName} onJump={onJump} />
    </section>
  )
}

/** 游標與機制結算時間相差多少以內，視為「正在結算」而高亮該機制 */
const MECHANIC_ACTIVE_MS = 1500

/**
 * 站位差異以一張張卡片橫向排列（單字卡式），游標進入某段時高亮該卡片並捲到可見位置。
 * 點卡片跳到該段開始。
 */
function DivergenceCards({
  divergences,
  track,
  cursor,
  abilityName,
  onJump,
}: {
  divergences: Divergence[]
  track: TrackPoint[]
  cursor: number
  abilityName: (id: number) => string
  onJump: (t: number) => void
}) {
  const strip = useRef<HTMLOListElement>(null)
  const active = divergences.findIndex((d) => cursor >= d.start && cursor <= d.end)

  // 進入新的一段時把卡片捲到中間；只捲卡片列本身（立即設定），不動整頁，也不與時間軸的捲動互相中斷
  useEffect(() => {
    const el = strip.current
    const card = el?.children[active] as HTMLElement | undefined
    if (!el || !card) return
    const left = card.offsetLeft - (el.clientWidth - card.offsetWidth) / 2
    el.scrollLeft = Math.max(0, left)
  }, [active])

  if (divergences.length === 0) return null
  return (
    <ol className="divergence-cards" ref={strip}>
      {divergences.map((d, i) => {
        // 同一段內重複的機制名稱只列一次，最多列 3 個；附上機制結算當下兩人的距離
        const seen = new Set<string>()
        const unique = d.mechanics
          .map((m) => ({ name: abilityName(m.abilityId), t: m.t }))
          .filter((m) => !seen.has(m.name) && seen.add(m.name))
        const classes = ['divergence-card', d.mechanics.length > 0 && 'at-mechanic', i === active && 'active']
        return (
          <li key={d.start} className={classes.filter(Boolean).join(' ')} aria-current={i === active ? 'true' : undefined}>
            <button type="button" onClick={() => onJump(d.start)} title="跳到這段開始">
              <span className="card-time">
                {formatFightTime(d.start)}–{formatFightTime(d.end)}
              </span>
              <span className="card-distance">
                <strong>{d.maxDistance.toFixed(1)}</strong> yalm
                <span className="card-sub">最遠</span>
              </span>
              <span className="card-tags">
                {d.mechanics.length > 0 && <span className="tag mechanic">機制</span>}
                {d.mirror && <span className="tag">可能是{MIRROR_LABELS[d.mirror]}站位</span>}
                {d.mechanics.length === 0 && !d.mirror && <span className="card-sub">移動路線不同</span>}
              </span>
              {unique.length > 0 && (
                <span className="card-mechanics">
                  {unique.slice(0, MAX_LISTED_MECHANICS).map((m) => {
                    const distance = distanceAt(track, m.t)
                    const now = Math.abs(cursor - m.t) <= MECHANIC_ACTIVE_MS
                    return (
                      <span key={m.name} className={now ? 'card-mechanic now' : 'card-mechanic'}>
                        <span className="card-mechanic-name">{m.name}</span>
                        <span className="card-sub">
                          {formatFightTime(m.t)}
                          {distance != null && ` · ${distance.toFixed(1)} yalm`}
                        </span>
                      </span>
                    )
                  })}
                  {unique.length > MAX_LISTED_MECHANICS && <span className="card-sub">等 {unique.length} 個機制</span>}
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ol>
  )
}
