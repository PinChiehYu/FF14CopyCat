import {
  BOSS_FRAME_GAP_YALM,
  BOSS_LIMITS,
  bossPoseAt,
  distanceAt,
  divergenceKind,
  positionAt,
  MIRROR_LABELS,
  toBossFrame,
  type Divergence,
  type DivergenceKind,
  type DivergenceMechanic,
  type Point,
  type PositionSample,
  type TrackPoint,
} from '../analysis/positions'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { mechanicLabel } from '../analysis/mechanics'
import { formatFightTime } from '../analysis/timeline'

// 地圖上顯示游標前多久的移動軌跡
const TRAIL_MS = 5000
const MAP_SIZE = 360
const CHART_WIDTH = 1000
const CHART_HEIGHT = 90
// 距離圖底部標示「以各自 Boss 為基準」時段的細條高度，與相鄰取樣合併的間隔
const FRAME_STRIP_HEIGHT = 4
const FRAME_MERGE_MS = 1000
// 距離圖的區段色塊：不算站錯的（機制不同、無法選中、對稱）灰色，機制結算時站位不同紅色
const BAND_CLASS: Record<DivergenceKind, string> = {
  variant: 'band mirrored',
  untargetable: 'band mirrored',
  mirror: 'band mirrored',
  mechanic: 'band mechanic',
  'same-to-boss': 'band',
  route: 'band',
}
// 每段站位差異最多列出幾個機制
const MAX_LISTED_MECHANICS = 3
const SAME_TO_BOSS_TITLE =
  '機制結算時兩人相對於各自 Boss 的位置（依 Boss 面向）相近（8 yalm 內），站位不同是兩場 Boss 的位置或面向不同造成，不算機制結算時站位不同'
const BOSS_FRAME_TITLE = `兩場 Boss 站在不同位置（相距超過 ${BOSS_FRAME_GAP_YALM} yalm），場地上的距離沒有意義：距離改以各自 Boss 為基準（Boss 在中心、面向朝上，同「以 Boss 為中心」視角）`
const UNTARGETABLE_TITLE = '這段期間 Boss 無法選中（轉場等），玩家常被強制移動或無法移動，站位不同不一定是站錯；不列入站位建議'

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
function EdgeArrow({ target, label, className }: { target: Point; label: string; className?: string }) {
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
    <g className={`edge-arrow${className ? ` ${className}` : ''}`}>
      <polygon points="9,0 -6,-7 -6,7" transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle.toFixed(1)})`} />
      <text x={tx.toFixed(1)} y={ty.toFixed(1)} textAnchor="middle">
        {label}
      </text>
    </g>
  )
}

/** Boss 標記：在圖內畫圓點，在圖外畫邊緣箭頭並標示離 from 多遠。 */
function BossMarker({
  at,
  px,
  from,
  label,
  className,
}: {
  at: Point
  px: (p: Point) => Point
  from: Point | null | undefined
  label: string
  className: string
}) {
  const p = px(at)
  if (p.x >= 0 && p.x <= MAP_SIZE && p.y >= 0 && p.y <= MAP_SIZE) {
    return <circle className={`boss-dot ${className}`} cx={p.x} cy={p.y} r={9} />
  }
  const distance = from ? ` ${Math.hypot(at.x - from.x, at.y - from.y).toFixed(0)} yalm` : ''
  return <EdgeArrow target={p} label={`${label}${distance}`} className={className} />
}

/**
 * 場地俯視圖（北方朝上）。
 * - two-bosses：照實際位置畫兩人與兩場的 Boss（我的 Boss 橘框、參考的 Boss 藍框）
 * - aligned：我的位置平移到參考 Boss 的位置（見 alignToBoss），只畫參考的 Boss
 */
function Arena({
  mode,
  track,
  cursor,
  mineSamples,
  mineAlignedSamples,
  refSamples,
  bossSamples,
  mineBossSamples,
}: {
  mode: 'two-bosses' | 'aligned'
  track: TrackPoint[]
  cursor: number
  /** 我的原始位置（參考時間） */
  mineSamples: PositionSample[]
  mineAlignedSamples: PositionSample[]
  refSamples: PositionSample[]
  bossSamples: PositionSample[]
  mineBossSamples: PositionSample[]
}) {
  const twoBosses = mode === 'two-bosses'
  const { minX, minY, size } = bounds(
    [twoBosses ? mineSamples : mineAlignedSamples, refSamples],
    twoBosses ? [...bossSamples, ...mineBossSamples] : bossSamples,
    cursor,
  )
  const scale = MAP_SIZE / size
  const px = (p: Point) => ({ x: (p.x - minX) * scale, y: (p.y - minY) * scale })
  // track 的 mine 是原始位置；對齊 Boss 時改用平移後的位置
  const mineAt = (p: TrackPoint) => (twoBosses ? p.mine : positionAt(mineAlignedSamples, p.t))
  const trail = (pick: (p: TrackPoint) => Point | null) =>
    track
      .filter((p) => p.t > cursor - TRAIL_MS && p.t <= cursor)
      .map(pick)
      .filter((p): p is Point => p !== null)
      .map(px)
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ')
  const now = nearest(track, cursor)
  const mine = now ? mineAt(now) : null
  const mineBoss = twoBosses && now ? positionAt(mineBossSamples, now.t, BOSS_LIMITS) : null
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
      <polyline className="trail ref" points={trail((p) => p.ref)} />
      <polyline className="trail mine" points={trail(mineAt)} />
      {now?.boss && (
        <BossMarker at={now.boss} px={px} from={now.ref} label={twoBosses ? '參考 Boss' : 'Boss'} className={twoBosses ? 'ref' : ''} />
      )}
      {mineBoss && <BossMarker at={mineBoss} px={px} from={mine} label="我的 Boss" className="mine" />}
      {now?.ref && <circle className="dot ref" cx={px(now.ref).x} cy={px(now.ref).y} r={6} />}
      {mine && <circle className="dot mine" cx={px(mine).x} cy={px(mine).y} r={6} />}
      <text className="north" x={MAP_SIZE - 14} y={16}>
        N
      </text>
    </svg>
  )
}
/** 以 Boss 為中心時，一側在某時間點相對於自己那一場 Boss 的位置 */
function relativeAt(player: Point | null, bossSamples: PositionSample[], t: number): Point | null {
  if (!player) return null
  const pose = bossPoseAt(bossSamples, t)
  return pose ? toBossFrame(player, pose) : null
}

// 以 Boss 為中心：範圍對齊到這個格距（yalm）
const BOSS_VIEW_STEP_YALM = 10

/**
 * 以 Boss 為中心的俯視圖：Boss 在中央、面向朝上，兩位玩家各自換算成相對於自己那一場 Boss 的位置，
 * 兩場的 Boss 站位、面向不同也能比較「站在 Boss 的哪一側」。虛線為正面／側面／背面的分界（±45°、±135°）。
 */
function BossArena({
  track,
  cursor,
  mineSamples,
  mineBoss,
  refBoss,
}: {
  track: TrackPoint[]
  cursor: number
  /** 我的原始位置（參考時間） */
  mineSamples: PositionSample[]
  /** 我的日誌的 Boss 位置（已換算成參考時間） */
  mineBoss: PositionSample[]
  refBoss: PositionSample[]
}) {
  const rel = (p: TrackPoint) => ({
    mine: relativeAt(positionAt(mineSamples, p.t), mineBoss, p.t),
    ref: relativeAt(p.ref, refBoss, p.t),
  })
  const now = nearest(track, cursor)
  const current = now ? rel(now) : { mine: null, ref: null }
  // 範圍：游標前後 10 秒內離 Boss 最遠的距離，對齊 10 yalm
  const around = track.filter((p) => Math.abs(p.t - cursor) <= VIEW_WINDOW_MS && p.t % 1000 === 0).map(rel)
  const far = Math.max(
    MIN_VIEW_YALM / 2,
    ...around.flatMap((r) => [r.mine, r.ref]).filter((p): p is Point => p !== null).map((p) => Math.hypot(p.x, p.y) + 3),
  )
  const size = Math.ceil((far * 2) / BOSS_VIEW_STEP_YALM) * BOSS_VIEW_STEP_YALM
  const scale = MAP_SIZE / size
  const c = MAP_SIZE / 2
  const px = (p: Point) => ({ x: c + p.x * scale, y: c + p.y * scale })
  const trail = (key: 'mine' | 'ref') =>
    track
      .filter((p) => p.t > cursor - TRAIL_MS && p.t <= cursor)
      .map((p) => rel(p)[key])
      .filter((p): p is Point => p !== null)
      .map(px)
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ')
  // 每 5 yalm 一圈
  const rings = Array.from({ length: Math.floor(size / 2 / 5) }, (_, i) => (i + 1) * 5)
  const diag = MAP_SIZE
  return (
    <svg className="arena boss-frame" viewBox={`0 0 ${MAP_SIZE} ${MAP_SIZE}`} role="img" aria-label="以 Boss 為中心的站位圖">
      {rings.map((r) => (
        <circle key={r} className="ring" cx={c} cy={c} r={r * scale} />
      ))}
      {[45, 135].map((deg) => {
        const rad = (deg * Math.PI) / 180
        const dx = Math.sin(rad) * diag
        const dy = -Math.cos(rad) * diag
        return (
          <g key={deg}>
            <line className="sector" x1={c} y1={c} x2={c + dx} y2={c + dy} />
            <line className="sector" x1={c} y1={c} x2={c - dx} y2={c + dy} />
          </g>
        )
      })}
      <text className="sector-label" x={c} y={16} textAnchor="middle">
        正面
      </text>
      <text className="sector-label" x={c} y={MAP_SIZE - 8} textAnchor="middle">
        背面
      </text>
      <text className="sector-label" x={10} y={c + 4}>
        側面
      </text>
      <text className="sector-label" x={MAP_SIZE - 10} y={c + 4} textAnchor="end">
        側面
      </text>
      <polyline className="trail ref" points={trail('ref')} />
      <polyline className="trail mine" points={trail('mine')} />
      {/* Boss：面向朝上的三角形 */}
      <polygon className="boss-dot" points={`${c},${c - 12} ${c - 9},${c + 8} ${c + 9},${c + 8}`} />
      {current.ref && <circle className="dot ref" cx={px(current.ref).x} cy={px(current.ref).y} r={6} />}
      {current.mine && <circle className="dot mine" cx={px(current.mine).x} cy={px(current.mine).y} r={6} />}
    </svg>
  )
}

// two-bosses：場地、兩場的 Boss 都畫；aligned：我的位置對齊到參考的 Boss；boss：以 Boss 為中心
type ArenaMode = 'two-bosses' | 'aligned' | 'boss'
const ARENA_MODE_KEY = 'arenaMode'

function readArenaMode(): ArenaMode {
  try {
    const saved = localStorage.getItem(ARENA_MODE_KEY)
    // 舊版的 arena（只畫參考的 Boss）改為兩個 Boss
    return saved === 'boss' ? 'boss' : saved === 'arena' || saved === 'two-bosses' ? 'two-bosses' : 'aligned'
  } catch {
    return 'aligned'
  }
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
  // 以各自 Boss 為基準判定的時段（兩場 Boss 站在不同位置）：底部細條標示
  const framed: { start: number; end: number }[] = []
  for (const p of track) {
    if (!p.bossFrame) continue
    const last = framed.at(-1)
    if (last && p.t - last.end <= FRAME_MERGE_MS) last.end = p.t
    else framed.push({ start: p.t, end: p.t })
  }

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
      {framed.map((f) => (
        <rect
          key={`frame-${f.start}`}
          className="boss-frame-strip"
          x={x(f.start)}
          width={Math.max(1, x(f.end) - x(f.start))}
          y={CHART_HEIGHT - FRAME_STRIP_HEIGHT}
          height={FRAME_STRIP_HEIGHT}
        />
      ))}
      {divergences.map((d) => (
        <rect
          key={d.start}
          className={BAND_CLASS[divergenceKind(d)]}
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
  mineBossSamples,
  mineAlignedSamples,
  threshold,
  duration,
  cursor,
  onSeek,
  onJump,
  status,
}: {
  /** 顯示在站位圖旁的當下狀態（血量、Buff、Boss 施放）；參數為俯視圖是否顯示兩場的 Boss */
  status?: (twoBosses: boolean) => ReactNode
  abilityName: (id: number) => string
  track: TrackPoint[]
  divergences: Divergence[]
  /** 我的原始位置，已換算成參考時間 */
  mineSamples: PositionSample[]
  /** 我的位置對齊到參考 Boss 後（只用於俯視圖的「對齊 Boss」） */
  mineAlignedSamples: PositionSample[]
  refSamples: PositionSample[]
  /** 參考日誌的 Boss 位置（決定俯視圖的範圍） */
  bossSamples: PositionSample[]
  /** 我的日誌的 Boss 位置（已換算成參考時間；以 Boss 為中心時用） */
  mineBossSamples: PositionSample[]
  threshold: number
  duration: number
  cursor: number
  /** 只移動游標（拖曳、點圖表） */
  onSeek: (t: number) => void
  /** 移動游標並捲動時間軸（點清單） */
  onJump: (t: number) => void
}) {
  // 俯視圖的視角：場地（北方朝上）或以 Boss 為中心（面向朝上）；記在瀏覽器
  const [mode, setMode] = useState<ArenaMode>(readArenaMode)
  const changeMode = (next: ArenaMode) => {
    setMode(next)
    try {
      localStorage.setItem(ARENA_MODE_KEY, next)
    } catch {
      // 無法儲存時只影響下次開啟的預設值
    }
  }
  const now = nearest(track, cursor)
  const hasData = track.some((p) => p.distance !== null)
  if (!hasData) return <p className="hint">這兩份日誌沒有足夠的位置資料。</p>
  // 以 Boss 為中心需要兩邊當下的 Boss 位置與面向；沒有時（Boss 無法選取、轉場）暫時以場地顯示
  const bossFrameReady = bossPoseAt(bossSamples, cursor) !== null && bossPoseAt(mineBossSamples, cursor) !== null
  const showBossFrame = mode === 'boss' && bossFrameReady
  // 對齊 Boss：這個時間點兩邊都有 Boss 位置時才有對齊
  const alignedNow =
    positionAt(bossSamples, cursor, BOSS_LIMITS) !== null && positionAt(mineBossSamples, cursor, BOSS_LIMITS) !== null
  // 每段只算一種分類（divergenceKind：機制不同 → 無法選中 → 對稱 → 機制），與卡片、建議一致
  const count = (kind: DivergenceKind) => divergences.filter((d) => divergenceKind(d) === kind).length
  const byVariant = count('variant')
  const untargetable = count('untargetable')
  const atMechanic = count('mechanic')
  const mirrored = count('mirror')
  const bossFramed = divergences.filter((d) => d.bossFrame).length

  return (
    <section className="positions">
      {/* 一行摘要，說明放在滑鼠提示 */}
      <p className="positions-summary">
        <span
          title={`兩人相距超過 ${threshold} yalm、持續 2 秒以上的時段。兩場 Boss 站在不同位置（相距超過 ${BOSS_FRAME_GAP_YALM} yalm）時，距離改以各自 Boss 為基準（同「以 Boss 為中心」視角）；距離圖底部的細條標示這些時段`}
        >
          站位差異 <strong>{divergences.length}</strong> 段
        </span>
        {atMechanic > 0 && (
          <span className="tag mechanic" title="Boss 機制結算時仍站在不同位置，最值得對照；其餘多半只是移動路線不同">
            機制 {atMechanic}
          </span>
        )}
        {byVariant > 0 && (
          <span className="tag variant" title="這些時段兩邊的 Boss 隨機機制不同，站位不同多半是機制造成">
            機制不同 {byVariant}
          </span>
        )}
        {untargetable > 0 && (
          <span className="tag" title={UNTARGETABLE_TITLE}>
            無法選中 {untargetable}
          </span>
        )}
        {mirrored > 0 && (
          <span className="tag" title="你的位置接近參考位置的對稱點，可能是攻略或分配不同">
            可能對稱 {mirrored}
          </span>
        )}
        {bossFramed > 0 && (
          <span className="tag" title={BOSS_FRAME_TITLE}>
            以 Boss 為基準 {bossFramed}
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
          <div className="arena-modes" role="group" aria-label="俯視圖視角">
            <button
              type="button"
              className={mode === 'two-bosses' ? 'active' : undefined}
              aria-pressed={mode === 'two-bosses'}
              title="北方朝上，照實際位置畫兩人與兩場的 Boss（橘框：我的 Boss、藍框：參考的 Boss）"
              onClick={() => changeMode('two-bosses')}
            >
              兩個 Boss
            </button>
            <button
              type="button"
              className={mode === 'aligned' ? 'active' : undefined}
              aria-pressed={mode === 'aligned'}
              title="北方朝上；保留你相對於你那一場 Boss 的位置，平移到參考 Boss 的位置上（不旋轉）。只影響這張圖，距離與站位差異仍以場地上的位置計算"
              onClick={() => changeMode('aligned')}
            >
              對齊 Boss
            </button>
            <button
              type="button"
              className={mode === 'boss' ? 'active' : undefined}
              aria-pressed={mode === 'boss'}
              title="Boss 在中央、面向朝上；兩人各自換算成相對於自己那一場 Boss 的位置，可比較站在 Boss 的哪一側"
              onClick={() => changeMode('boss')}
            >
              以 Boss 為中心
            </button>
            {mode === 'boss' && !bossFrameReady && (
              <span className="hint-inline" title="這個時間點至少一邊沒有 Boss 的位置或面向（Boss 無法選取、轉場等）">
                Boss 不在場，暫以場地顯示
              </span>
            )}
          </div>
          {showBossFrame ? (
            <BossArena track={track} cursor={cursor} mineSamples={mineSamples} mineBoss={mineBossSamples} refBoss={bossSamples} />
          ) : (
            <Arena
              mode={mode === 'two-bosses' ? 'two-bosses' : 'aligned'}
              track={track}
              cursor={cursor}
              mineSamples={mineSamples}
              mineAlignedSamples={mineAlignedSamples}
              refSamples={refSamples}
              bossSamples={bossSamples}
              mineBossSamples={mineBossSamples}
            />
          )}
          <p className="arena-caption">
            <span className="legend mine">● 我</span> <span className="legend ref">● 參考</span>{' '}
            {mode === 'two-bosses' ? (
              <>
                <span className="legend boss mine">◯ 我的 Boss</span> <span className="legend boss ref">◯ 參考 Boss</span>
              </>
            ) : (
              <span className="legend boss" title={now?.boss ? undefined : '這個時間點沒有 Boss 的位置資料（Boss 無法選取、轉場等）'}>
                ● Boss{now?.boss ? '' : '（不在場）'}
              </span>
            )}
            {mode === 'aligned' && !alignedNow && (
              <span className="hint-inline" title="這個時間點至少一邊沒有 Boss 的位置（Boss 無法選取、轉場等），你的位置以原始位置顯示">
                （未對齊）
              </span>
            )}
            {now?.distance != null &&
              (now.bossFrame ? (
                <span title={`${BOSS_FRAME_TITLE}\n場地上相距 ${now.arenaDistance?.toFixed(1)} yalm；兩場 Boss 相距 ${now.bossGap?.toFixed(1)} yalm`}>
                  {'　'}相對 Boss 相距 {now.distance.toFixed(1)} yalm
                </span>
              ) : (
                <span title="兩人在場地上的距離（不論俯視圖的視角）；兩場 Boss 在同一處，站位差異依此判斷">
                  {'　'}相距 {now.distance.toFixed(1)} yalm
                </span>
              ))}
          </p>
        </div>
        {status?.(mode === 'two-bosses')}
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
        // 同一段內重複的機制名稱只列一次，最多列 3 個；附上兩邊各自結算的時間與結算當下兩人的距離。
        // 同名的不同版本（左右等，技能 ID 不同）各自只有一邊，合併後兩邊的時間各取第一個
        const byName = new Map<string, DivergenceMechanic & { name: string }>()
        for (const m of d.mechanics) {
          const name = abilityName(m.abilityId)
          const first = byName.get(name)
          if (!first) byName.set(name, { ...m, name })
          else byName.set(name, { ...first, mine: first.mine ?? m.mine, ref: first.ref ?? m.ref })
        }
        const unique = [...byName.values()]
        // 每段只有一種分類（與摘要、建議一致）；「以 Boss 為基準」是另外的說明標籤
        const kind = divergenceKind(d)
        const classes = [
          'divergence-card',
          kind === 'mechanic' && 'at-mechanic',
          kind === 'variant' && 'by-variant',
          i === active && 'active',
        ]
        const variantTitle = d.variant
          ? [
              `兩邊的 Boss 隨機機制不同（${formatFightTime(d.variant.t)}）`,
              `我：${mechanicLabel(d.variant.mine, d.variant.ref, abilityName)}`,
              `參考：${mechanicLabel(d.variant.ref, d.variant.mine, abilityName)}`,
              '站位不同多半是機制造成，不是站錯',
            ].join('\n')
          : undefined
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
                {kind === 'variant' && (
                  <span className="tag variant" title={variantTitle}>
                    機制不同
                  </span>
                )}
                {kind === 'untargetable' && (
                  <span className="tag" title={UNTARGETABLE_TITLE}>
                    Boss 無法選中
                  </span>
                )}
                {kind === 'mirror' && (
                  <span className="tag" title="你的位置接近參考位置的對稱點，可能是攻略或分配不同；不列入站位建議">
                    可能是{MIRROR_LABELS[d.mirror!]}站位
                  </span>
                )}
                {kind === 'mechanic' && <span className="tag mechanic">機制</span>}
                {kind === 'same-to-boss' && (
                  <span className="tag" title={SAME_TO_BOSS_TITLE}>
                    相對 Boss 相同
                  </span>
                )}
                {kind === 'route' && <span className="card-sub">移動路線不同</span>}
                {d.bossFrame && (
                  <span className="tag" title={`${BOSS_FRAME_TITLE}\n這段兩場 Boss 最遠相距 ${(d.bossGap ?? 0).toFixed(0)} yalm`}>
                    以 Boss 為基準
                  </span>
                )}
              </span>
              {unique.length > 0 && (
                <span className="card-mechanics">
                  {unique.slice(0, MAX_LISTED_MECHANICS).map((m) => {
                    const distance = distanceAt(track, m.t)
                    const now = Math.abs(cursor - m.t) <= MECHANIC_ACTIVE_MS
                    const yalm = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(1))
                    return (
                      <span
                        key={m.name}
                        className={['card-mechanic', now && 'now', m.sameToBoss && 'same-to-boss'].filter(Boolean).join(' ')}
                        title={m.sameToBoss ? SAME_TO_BOSS_TITLE : undefined}
                      >
                        <span className="card-mechanic-name">{m.name}</span>
                        <span className="card-sub" title="兩邊各自結算的時間（各自的戰鬥時間）；—：這段期間那一邊沒有結算">
                          我 {m.mine !== undefined ? formatFightTime(m.mine) : '—'} · 參考 {m.ref !== undefined ? formatFightTime(m.ref) : '—'}
                        </span>
                        <span
                          className="card-sub"
                          title={`結算當下（yalm）\n兩人相距：${yalm(distance)}${d.bossFrame ? '（以各自 Boss 為基準）' : ''}\n我離我的 Boss：${yalm(m.mineToBoss)}\n參考離參考的 Boss：${yalm(m.refToBoss)}\n—：沒有位置資料`}
                        >
                          {distance != null && `相距 ${distance.toFixed(1)} · `}距王 {yalm(m.mineToBoss)}／{yalm(m.refToBoss)}
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
