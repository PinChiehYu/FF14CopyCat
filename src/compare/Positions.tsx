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
import { HelpTip } from './HelpTip'

// 地圖上顯示游標前多久的移動軌跡
const TRAIL_MS = 5000
const MAP_SIZE = 360
// Boss 面向三角形（像素，相對於 Boss 圓點中心；圓點半徑 9）
const FACING_TIP_PX = 19
const FACING_BASE_PX = 8
const FACING_HALF_WIDTH_PX = 6
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

// 邊緣箭頭離圖邊的距離
const EDGE_INSET = 12

// 鏡頭要顯示的內容：游標前後這段時間內的位置（只看附近，遠處的位置進出時間窗時鏡頭不會跟著晃）
const CONTENT_BEFORE_MS = 2000
const CONTENT_AFTER_MS = 3000
// 圖至少涵蓋這麼大（yalm）
const MIN_VIEW_YALM = 30
// 重新取景時內容外框每邊留的空間（yalm）：留得比死區寬，取景後不會馬上又要移動
const VIEW_PAD_YALM = 5
// 死區：內容離畫面邊緣至少這麼遠、且畫面沒有比剛好容納內容的範圍大這麼多倍時，鏡頭不動
const DEAD_ZONE_INSET_YALM = 2
const ZOOM_OUT_RATIO = 1.6

interface Box {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

interface View {
  minX: number
  minY: number
  size: number
}

/**
 * 鏡頭要顯示的內容：游標前 2 秒到後 3 秒內兩位玩家的位置，與 Boss 在這段時間的位置；
 * 這段時間沒有資料時以時間上最接近的資料為準。
 */
function contentBox(players: PositionSample[][], bosses: PositionSample[][], cursor: number): Box | null {
  const near = (s: PositionSample[], t: number) => s.filter((p) => p.t >= t - CONTENT_BEFORE_MS && p.t <= t + CONTENT_AFTER_MS)
  const collect = (t: number) => [
    ...players.flatMap((s) => [...near(s, t), positionAt(s, t)]),
    ...bosses.flatMap((s) => [...near(s, t), positionAt(s, t, BOSS_LIMITS)]),
  ]
  let pts = collect(cursor).filter((p): p is Point => p !== null)
  if (pts.length === 0) {
    // 附近沒有資料（例如另一方的戰鬥已結束）：改以時間上最接近的資料為準
    const all = [...players.flat(), ...bosses.flat()]
    if (all.length === 0) return null
    const closest = all.reduce((a, b) => (Math.abs(b.t - cursor) < Math.abs(a.t - cursor) ? b : a)).t
    pts = collect(closest).filter((p): p is Point => p !== null)
  }
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

/** 剛好容納內容的正方形範圍（至少 MIN_VIEW_YALM，每邊留 VIEW_PAD_YALM），置中於內容。 */
function fitView(box: Box | null): View {
  if (!box) return { minX: 80, minY: 80, size: 40 }
  const size = Math.max(box.maxX - box.minX, box.maxY - box.minY, MIN_VIEW_YALM) + VIEW_PAD_YALM * 2
  const cx = (box.minX + box.maxX) / 2
  const cy = (box.minY + box.maxY) / 2
  return { minX: cx - size / 2, minY: cy - size / 2, size }
}

// 需要移動時，顯示範圍靠近目標的時間常數（游標時間）：約 1 秒追上 63%，倍速播放時跟著變快
const VIEW_EASE_MS = 1000
// 游標一次移動超過這麼久（拖曳、點卡片跳轉）時直接換到目標範圍
const VIEW_SNAP_MS = 2000

const within = (p: Point, v: View, inset: number) =>
  p.x >= v.minX + inset && p.x <= v.minX + v.size - inset && p.y >= v.minY + inset && p.y <= v.minY + v.size - inset

/**
 * 死區鏡頭（遊戲鏡頭常見的做法）：內容還在畫面內（離邊緣至少 DEAD_ZONE_INSET_YALM）、且畫面沒有大到超過需要的
 * ZOOM_OUT_RATIO 倍時，鏡頭完全不動；否則依游標前進的時間平滑靠近剛好容納內容的範圍（連續平移、縮放）。
 * 跳轉、換視角（resetKey 改變）或當下的點（keep）會跑出畫面時直接換到目標，圓點不會跑到圖外。
 * 原本每次都追「前後 10 秒外框」的目標，遠處的位置進出時間窗時目標一直變，鏡頭來回晃。
 * 以 state 記住上一次的範圍（React「儲存前一次 render 的資訊」的做法）：游標或視角改變時才更新，
 * 更新後的 render 游標相同（dt = 0），不會再次更新。
 */
function useDeadZoneView(box: Box | null, cursor: number, keep: (Point | null)[], resetKey: string): View {
  const [prev, setPrev] = useState<{ view: View; cursor: number; key: string } | null>(null)
  const target = fitView(box)
  let view = target
  if (prev && prev.key === resetKey && box) {
    const dt = Math.abs(cursor - prev.cursor)
    const pv = prev.view
    const contentInside =
      within({ x: box.minX, y: box.minY }, pv, DEAD_ZONE_INSET_YALM) && within({ x: box.maxX, y: box.maxY }, pv, DEAD_ZONE_INSET_YALM)
    if (dt <= VIEW_SNAP_MS) {
      if (contentInside && pv.size <= target.size * ZOOM_OUT_RATIO) {
        view = pv
      } else {
        const k = 1 - Math.exp(-dt / VIEW_EASE_MS)
        const eased: View = {
          minX: pv.minX + (target.minX - pv.minX) * k,
          minY: pv.minY + (target.minY - pv.minY) * k,
          size: pv.size + (target.size - pv.size) * k,
        }
        if (keep.every((p) => !p || within(p, eased, 1))) view = eased
      }
    }
  }
  if (!prev || prev.cursor !== cursor || prev.key !== resetKey) setPrev({ view, cursor, key: resetKey })
  return view
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

/** 俯視圖滑鼠提示用的角色名稱（Boss 只標「我的 Boss／參考 Boss」） */
export interface ArenaNames {
  mine: string
  ref: string
}

/** 場地座標（yalm，FFLogs 的座標 ÷ 100） */
function coord(p: Point): string {
  return `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`
}

/** 玩家圓點的滑鼠提示：「我：名稱」＋場地座標＋附註 */
function playerTitle(label: string, name: string, at: Point | null, note = ''): string {
  return `${label}：${name}${at ? `\n座標 ${coord(at)}` : ''}${note}`
}

/**
 * Boss 標記：在圖內畫圓點（有面向資料時加上指向面向的三角形），在圖外畫邊緣箭頭並標示離 from 多遠。
 * @param facing Boss 面向（弧度，方向為 (cos, sin)，與座標同一平面；見 bossPoseAt）；沒有資料時不畫面向
 */
function BossMarker({
  at,
  px,
  from,
  label,
  className,
  facing,
}: {
  at: Point
  px: (p: Point) => Point
  from: Point | null | undefined
  label: string
  className: string
  facing?: number
}) {
  const p = px(at)
  if (p.x >= 0 && p.x <= MAP_SIZE && p.y >= 0 && p.y <= MAP_SIZE) {
    const nose =
      facing === undefined
        ? null
        : (() => {
            // 俯視圖只平移縮放、不翻轉，面向向量在畫面上方向相同
            const dx = Math.cos(facing)
            const dy = Math.sin(facing)
            const point = (along: number, side: number) =>
              `${(p.x + dx * along - dy * side).toFixed(1)},${(p.y + dy * along + dx * side).toFixed(1)}`
            return `${point(FACING_TIP_PX, 0)} ${point(FACING_BASE_PX, FACING_HALF_WIDTH_PX)} ${point(FACING_BASE_PX, -FACING_HALF_WIDTH_PX)}`
          })()
    return (
      <g>
        {/* 滑鼠提示：名稱與座標；重疊時瀏覽器只顯示最上層（參考在上）的提示 */}
        <title>{`${label}\n座標 ${coord(at)}${facing === undefined ? '\n沒有面向資料' : ''}`}</title>
        <circle className={`boss-dot ${className}`} cx={p.x} cy={p.y} r={9} />
        {nose && <polygon className={`boss-facing ${className}`} points={nose} />}
      </g>
    )
  }
  const distance = from ? ` ${Math.hypot(at.x - from.x, at.y - from.y).toFixed(0)} yalm` : ''
  return <EdgeArrow target={p} label={`${label}${distance}`} className={className} />
}

/**
 * 場地俯視圖（北方朝上）。
 * - two-bosses：照實際位置畫兩人與兩場的 Boss（我的 Boss 橘框、參考的 Boss 藍框）
 * - aligned：我的位置平移到參考 Boss 的位置（見 alignToBoss），只畫參考的 Boss（藍框，同 two-bosses 的參考 Boss）
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
  names,
  solo,
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
  names: ArenaNames
  /** 還沒有參考日誌：只畫我與我的 Boss（bossSamples 為我的 Boss） */
  solo?: boolean
}) {
  const twoBosses = mode === 'two-bosses'
  // track 的 mine 是原始位置；對齊 Boss 時改用平移後的位置
  const mineSource = twoBosses ? mineSamples : mineAlignedSamples
  // 當下的位置直接在游標時間內插（track 每 0.5 秒一點，取最近的點播放時會一格一格跳）
  const mine = positionAt(mineSource, cursor)
  const ref = positionAt(refSamples, cursor)
  const content = contentBox([mineSource, refSamples], twoBosses ? [bossSamples, mineBossSamples] : [bossSamples], cursor)
  const { minX, minY, size } = useDeadZoneView(content, cursor, [mine, ref], mode)
  const scale = MAP_SIZE / size
  const px = (p: Point) => ({ x: (p.x - minX) * scale, y: (p.y - minY) * scale })
  const refBoss = positionAt(bossSamples, cursor, BOSS_LIMITS)
  const mineBoss = twoBosses ? positionAt(mineBossSamples, cursor, BOSS_LIMITS) : null
  // 軌跡：前 5 秒的 track 取樣，接到當下的位置
  const trail = (pick: (p: TrackPoint) => Point | null, current: Point | null) =>
    [...track.filter((p) => p.t > cursor - TRAIL_MS && p.t < cursor).map(pick), current]
      .filter((p): p is Point => p !== null)
      .map(px)
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ')
  // Boss 面向（前後 5 秒內有取樣才有）
  const refFacing = bossPoseAt(bossSamples, cursor)?.facing
  const mineFacing = twoBosses ? bossPoseAt(mineBossSamples, cursor)?.facing : undefined
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
      {/* 參考在我之上（後畫）：軌跡與圓點都是 */}
      <polyline className="trail mine" points={trail((p) => (twoBosses ? p.mine : positionAt(mineAlignedSamples, p.t)), mine)} />
      <polyline className="trail ref" points={trail((p) => p.ref, ref)} />
      {/* 兩個 Boss 重疊時參考的 Boss 在上方（後畫） */}
      {mineBoss && (
        <BossMarker at={mineBoss} px={px} from={mine} label="我的 Boss" className="mine" facing={mineFacing} />
      )}
      {refBoss && (
        <BossMarker
          at={refBoss}
          px={px}
          from={solo ? mine : ref}
          label={solo ? 'Boss' : '參考 Boss'}
          className={solo ? 'mine' : 'ref'}
          facing={refFacing}
        />
      )}
      {/* 滑鼠提示：名稱與座標（對齊 Boss 時圖上的位置是平移後的，提示顯示原始座標） */}
      {mine && (
        <circle className="dot mine" cx={px(mine).x} cy={px(mine).y} r={6}>
          <title>{playerTitle('我', names.mine, positionAt(mineSamples, cursor), twoBosses || solo ? '' : '\n圖上已平移對齊參考 Boss')}</title>
        </circle>
      )}
      {ref && (
        <circle className="dot ref" cx={px(ref).x} cy={px(ref).y} r={6}>
          <title>{playerTitle('參考', names.ref, ref)}</title>
        </circle>
      )}
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

/**
 * 以 Boss 為中心的俯視圖：Boss 在中央、面向朝上，兩位玩家各自換算成相對於自己那一場 Boss 的位置，
 * 兩場的 Boss 站位、面向不同也能比較「站在 Boss 的哪一側」。虛線為正面／側面／背面的分界（±45°、±135°）。
 */
function BossArena({
  track,
  cursor,
  mineSamples,
  refSamples,
  mineBoss,
  refBoss,
  names,
  solo,
}: {
  track: TrackPoint[]
  cursor: number
  /** 我的原始位置（參考時間） */
  mineSamples: PositionSample[]
  refSamples: PositionSample[]
  /** 我的日誌的 Boss 位置（已換算成參考時間） */
  mineBoss: PositionSample[]
  refBoss: PositionSample[]
  names: ArenaNames
  /** 還沒有參考日誌：只畫我，Boss 為我的 Boss */
  solo?: boolean
}) {
  const relAt = (t: number) => ({
    mine: relativeAt(positionAt(mineSamples, t), mineBoss, t),
    ref: relativeAt(positionAt(refSamples, t), refBoss, t),
  })
  const rel = (p: TrackPoint) => relAt(p.t)
  // 當下的位置直接在游標時間內插（不取 track 的 0.5 秒取樣，播放時才不會一格一格跳）
  const current = relAt(cursor)
  // 內容：游標前 2 秒到後 3 秒內離 Boss 最遠的距離（以 Boss 為中心的正方形）；死區鏡頭只調整大小
  const around = [
    ...track.filter((p) => p.t >= cursor - CONTENT_BEFORE_MS && p.t <= cursor + CONTENT_AFTER_MS).map(rel),
    current,
  ]
  const far = Math.max(0, ...around.flatMap((r) => [r.mine, r.ref]).filter((p): p is Point => p !== null).map((p) => Math.hypot(p.x, p.y)))
  const { size } = useDeadZoneView({ minX: -far, maxX: far, minY: -far, maxY: far }, cursor, [current.mine, current.ref], 'boss')
  const scale = MAP_SIZE / size
  const c = MAP_SIZE / 2
  const px = (p: Point) => ({ x: c + p.x * scale, y: c + p.y * scale })
  const trail = (key: 'mine' | 'ref') =>
    [...track.filter((p) => p.t > cursor - TRAIL_MS && p.t < cursor).map((p) => rel(p)[key]), current[key]]
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
      {/* 參考在我之上（後畫） */}
      <polyline className="trail mine" points={trail('mine')} />
      <polyline className="trail ref" points={trail('ref')} />
      {/* Boss：面向朝上的三角形；位置與面向以參考的 Boss 為準（藍框同其他視角的參考 Boss） */}
      <polygon className={`boss-dot ${solo ? 'mine' : 'ref'}`} points={`${c},${c - 12} ${c - 9},${c + 8} ${c + 9},${c + 8}`}>
        {(() => {
          const at = positionAt(refBoss, cursor, BOSS_LIMITS)
          return <title>{`${solo ? 'Boss' : '參考 Boss'}${at ? `\n座標 ${coord(at)}` : ''}`}</title>
        })()}
      </polygon>
      {/* 滑鼠提示：名稱、場地座標與離自己那一場 Boss 的距離（圖上是相對於 Boss 的位置） */}
      {current.mine && (
        <circle className="dot mine" cx={px(current.mine).x} cy={px(current.mine).y} r={6}>
          <title>
            {playerTitle('我', names.mine, positionAt(mineSamples, cursor), `\n距${solo ? '' : '我的 '}Boss ${Math.hypot(current.mine.x, current.mine.y).toFixed(1)} yalm`)}
          </title>
        </circle>
      )}
      {current.ref && (
        <circle className="dot ref" cx={px(current.ref).x} cy={px(current.ref).y} r={6}>
          <title>
            {playerTitle('參考', names.ref, positionAt(refSamples, cursor), `\n距參考 Boss ${Math.hypot(current.ref.x, current.ref.y).toFixed(1)} yalm`)}
          </title>
        </circle>
      )}
    </svg>
  )
}

// 手機寬度的分頁
type PositionsTab = 'arena' | 'status' | 'cards'
const POSITIONS_TABS: [PositionsTab, string][] = [
  ['arena', '俯視圖'],
  ['status', '當下狀態'],
  ['cards', '站位差異'],
]
const POSITIONS_TAB_KEY = 'positionsTab'
function readPositionsTab(): PositionsTab {
  try {
    const saved = localStorage.getItem(POSITIONS_TAB_KEY)
    return saved === 'status' || saved === 'cards' ? saved : 'arena'
  } catch {
    return 'arena'
  }
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
  names,
  threshold,
  duration,
  cursor,
  onSeek,
  onJump,
  status,
  solo = false,
  isFocused = null,
  refToMine = (t) => t,
}: {
  /** 關注的機制時間點（技能 ID、我的時間；見 focusedMechanics.ts），站位差異卡片中對到的機制高光；沒有選擇時為 null */
  isFocused?: ((abilityId: number, mineT: number) => boolean) | null
  refToMine?: (t: number) => number
  /**
   * 還沒有參考日誌：只顯示我的站位（refSamples 為空、bossSamples 與 mineBossSamples 都是我的 Boss）；
   * 不顯示距離、站位差異與「兩個 Boss」視角
   */
  solo?: boolean
  /** 顯示在站位圖旁的當下狀態（血量、Buff、Boss 施放） */
  status?: ReactNode
  /** 俯視圖滑鼠提示用的角色與 Boss 名稱 */
  names: ArenaNames
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
  // 手機寬度：俯視圖／當下狀態／站位差異以分頁切換（整區太長，播放時看不完）；桌面不顯示分頁、全部顯示。記在瀏覽器
  const [tab, setTab] = useState<PositionsTab>(readPositionsTab)
  const changeTab = (next: PositionsTab) => {
    setTab(next)
    try {
      localStorage.setItem(POSITIONS_TAB_KEY, next)
    } catch {
      // 無法儲存時只影響下次開啟的預設值
    }
  }
  const now = nearest(track, cursor)
  const hasData = solo ? mineSamples.length > 0 : track.some((p) => p.distance !== null)
  if (!hasData) return <p className="hint">{solo ? '這份日誌' : '這兩份日誌'}沒有足夠的位置資料。</p>
  // 沒有參考時沒有「兩個 Boss」視角與「站位差異」分頁
  const arenaMode: ArenaMode = solo && mode === 'two-bosses' ? 'aligned' : mode
  const shownTab: PositionsTab = solo && tab === 'cards' ? 'arena' : tab
  // 以 Boss 為中心需要兩邊當下的 Boss 位置與面向；沒有時（Boss 無法選取、轉場）暫時以場地顯示
  const bossFrameReady = bossPoseAt(bossSamples, cursor) !== null && bossPoseAt(mineBossSamples, cursor) !== null
  const showBossFrame = arenaMode === 'boss' && bossFrameReady
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
    <section className="positions" data-tab={shownTab}>
      {/* 一行摘要，說明放在「?」；沒有參考時沒有距離與站位差異 */}
      {!solo && (
      <p className="positions-summary">
        <span>
          站位差異 <strong>{divergences.length}</strong> 段
        </span>
        {atMechanic > 0 && <span className="tag mechanic">機制 {atMechanic}</span>}
        {byVariant > 0 && <span className="tag variant">機制不同 {byVariant}</span>}
        {untargetable > 0 && <span className="tag">無法選中 {untargetable}</span>}
        {mirrored > 0 && <span className="tag">可能對稱 {mirrored}</span>}
        {bossFramed > 0 && <span className="tag">以 Boss 為基準 {bossFramed}</span>}
        <HelpTip
          text={[
            `站位差異：兩人相距超過 ${threshold} yalm、持續 2 秒以上的時段；每段只屬於一種分類。距離圖的虛線為門檻，點擊圖表移動時間。`,
            '機制：Boss 機制結算時仍站在不同位置，最值得對照；其餘多半只是移動路線不同。',
            '機制不同：這些時段兩邊的 Boss 隨機機制不同，站位不同多半是機制造成。',
            `無法選中：${UNTARGETABLE_TITLE}`,
            '可能對稱：你的位置接近參考位置的對稱點，可能是攻略或分配不同。',
            `以 Boss 為基準：${BOSS_FRAME_TITLE}；距離圖底部的細條標示這些時段。`,
            `相對 Boss 相同：${SAME_TO_BOSS_TITLE}（卡片中灰色的機制）。`,
            '卡片的機制：「我 時間 · 參考 時間」為兩邊各自結算的時間（各自的戰鬥時間，— 為那一邊這段沒有結算）；「相距 · 距王 我／參考」為結算當下兩人的距離與各自離自己 Boss 的距離（yalm，— 為沒有位置資料）。滑鼠停在「機制不同」上可看兩邊不同的機制。',
            '紫色左條：卡片中有你在「搜尋前輩日誌」中關注的機制時間點（有取消勾選時才標）。',
          ].join('\n')}
        />
      </p>
      )}
      {!solo && (
      <DistanceChart
        track={track}
        divergences={divergences}
        cursor={cursor}
        threshold={threshold}
        duration={duration}
        onSeek={onSeek}
      />
      )}
      {/* 只在手機寬度顯示（CSS），隱藏未選的區塊 */}
      <div className="positions-tabs" role="tablist" aria-label="站位與當下狀態">
        {POSITIONS_TABS.filter(([key]) => !solo || key !== 'cards').map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={shownTab === key}
            className={shownTab === key ? 'active' : undefined}
            onClick={() => changeTab(key)}
          >
            {label}
            {key === 'cards' && ` ${divergences.length}`}
          </button>
        ))}
      </div>
      <div className="positions-body">
        <div className="arena-panel">
          <div className="arena-modes" role="group" aria-label="俯視圖視角">
            {!solo && (
            <button
              type="button"
              className={mode === 'two-bosses' ? 'active' : undefined}
              aria-pressed={mode === 'two-bosses'}
              title="北方朝上，照實際位置畫兩人與兩場的 Boss（橘框：我的 Boss、藍框：參考的 Boss）"
              onClick={() => changeMode('two-bosses')}
            >
              兩個 Boss
            </button>
            )}
            <button
              type="button"
              className={arenaMode === 'aligned' ? 'active' : undefined}
              aria-pressed={arenaMode === 'aligned'}
              title={
                solo
                  ? '北方朝上，照實際位置畫你與 Boss'
                  : '北方朝上；保留你相對於你那一場 Boss 的位置，平移到參考 Boss 的位置上（不旋轉）。只影響這張圖，距離與站位差異仍以場地上的位置計算'
              }
              onClick={() => changeMode('aligned')}
            >
              {solo ? '場地' : '對齊 Boss'}
            </button>
            <button
              type="button"
              className={mode === 'boss' ? 'active' : undefined}
              aria-pressed={mode === 'boss'}
              title={
                solo
                  ? 'Boss 在中央、面向朝上，看你站在 Boss 的哪一側'
                  : 'Boss 在中央、面向朝上；兩人各自換算成相對於自己那一場 Boss 的位置，可比較站在 Boss 的哪一側'
              }
              onClick={() => changeMode('boss')}
            >
              以 Boss 為中心
            </button>
            <HelpTip
              text={[
                '圖上角落的狀態（Boss 無法選取、轉場等時段）：',
                '・Boss 不在場：這個時間點沒有 Boss 的位置資料。',
                `・暫以場地顯示：以 Boss 為中心時，${solo ? '' : '至少一邊'}沒有 Boss 的位置或面向，暫時改以場地顯示。`,
                !solo && '・未對齊：對齊 Boss 時，至少一邊沒有 Boss 的位置，你的位置以原始位置顯示。',
              ]
                .filter(Boolean)
                .join('\n')}
            />
          </div>
          {/* 圖例與提示（左上）、距離（左下）疊在俯視圖內，不另佔行；右上是北方的 N */}
          <div className="arena-wrap">
            {showBossFrame ? (
              <BossArena
                track={track}
                cursor={cursor}
                mineSamples={mineSamples}
                refSamples={refSamples}
                mineBoss={mineBossSamples}
                refBoss={bossSamples}
                names={names}
                solo={solo}
              />
            ) : (
              <Arena
                mode={arenaMode === 'two-bosses' ? 'two-bosses' : 'aligned'}
                track={track}
                cursor={cursor}
                mineSamples={mineSamples}
                mineAlignedSamples={mineAlignedSamples}
                refSamples={refSamples}
                bossSamples={bossSamples}
                mineBossSamples={mineBossSamples}
                names={names}
                solo={solo}
              />
            )}
            <div className="arena-overlay top">
              <div className="arena-legend">
                {solo ? (
                  <>
                    <span className="legend mine">● 我</span>{' '}
                    <span className="legend boss mine">{showBossFrame ? '▲ Boss' : '◯ Boss'}</span>
                  </>
                ) : arenaMode === 'two-bosses' ? (
                  // 兩個 Boss：每位玩家緊接著自己那一場的 Boss
                  <>
                    <span className="legend mine">● 我</span> <span className="legend boss mine">◯ 我的 Boss</span>{' '}
                    <span className="legend ref">● 參考</span> <span className="legend boss ref">◯ 參考 Boss</span>
                  </>
                ) : (
                  // 對齊 Boss 與以 Boss 為中心都以參考的 Boss 為準（藍框同「兩個 Boss」的參考 Boss）
                  <>
                    <span className="legend mine">● 我</span> <span className="legend ref">● 參考</span>{' '}
                    <span className="legend boss ref">{showBossFrame ? '▲ 參考 Boss' : '◯ 參考 Boss'}</span>
                  </>
                )}
              </div>
              {/* 狀態的說明在視角按鈕旁的「?」 */}
              <div className="arena-hints">
                {!now?.boss && <span>Boss 不在場</span>}
                {mode === 'boss' && !bossFrameReady && <span>暫以場地顯示</span>}
                {arenaMode === 'aligned' && !solo && !alignedNow && <span>未對齊</span>}
              </div>
            </div>
            {now?.distance != null && (
              <div
                className="arena-overlay distance"
                title={
                  now.bossFrame
                    ? `${BOSS_FRAME_TITLE}\n相對 Boss 相距 ${now.distance.toFixed(1)} yalm；場地上相距 ${now.arenaDistance?.toFixed(1)} yalm；兩場 Boss 相距 ${now.bossGap?.toFixed(1)} yalm`
                    : `兩人在場地上相距 ${now.distance.toFixed(1)} yalm（不論俯視圖的視角）；兩場 Boss 在同一處，站位差異依此判斷`
                }
              >
                {now.bossFrame ? '相對 Boss ' : '相距 '}
                <strong>{now.distance.toFixed(1)}</strong>
              </div>
            )}
          </div>
        </div>
        {status}
      </div>
      {!solo && (
      <DivergenceCards
        divergences={divergences}
        track={track}
        cursor={cursor}
        abilityName={abilityName}
        isFocused={isFocused}
        refToMine={refToMine}
        shownKey={shownTab}
        onJump={(t) => {
          onJump(t)
          // 手機在「站位差異」分頁點卡片時，換到俯視圖看這段的站位（桌面沒有分頁，不影響）
          changeTab('arena')
        }}
      />
      )}
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
  shownKey,
  isFocused,
  refToMine,
}: {
  divergences: Divergence[]
  track: TrackPoint[]
  cursor: number
  abilityName: (id: number) => string
  onJump: (t: number) => void
  isFocused: ((abilityId: number, mineT: number) => boolean) | null
  refToMine: (t: number) => number
  /** 卡片列被重新顯示時改變（手機分頁）：隱藏時量不到位置，顯示後要再置中 */
  shownKey?: string
}) {
  const strip = useRef<HTMLOListElement>(null)
  const active = divergences.findIndex((d) => cursor >= d.start && cursor <= d.end)

  // 進入新的一段時把卡片捲到中間；只捲卡片列本身（立即設定），不動整頁，也不與時間軸的捲動互相中斷
  useEffect(() => {
    const el = strip.current
    const card = el?.children[active] as HTMLElement | undefined
    if (!el || !card || el.clientWidth === 0) return
    // 以畫面上的位置計算卡片在列中的位置：offsetLeft 是相對於 offsetParent（頁面），
    // 頁面內容置中、左邊有空白（寬螢幕）時會多算這段距離，卡片被捲到左邊只剩右半
    const cardLeft = el.scrollLeft + card.getBoundingClientRect().left - el.getBoundingClientRect().left
    el.scrollLeft = Math.max(0, cardLeft - (el.clientWidth - card.offsetWidth) / 2)
  }, [active, shownKey])

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
        // 關注的機制時間點（名稱）：我的結算時間，只有參考那邊結算時換成我的時間
        const focusedNames = new Set(
          isFocused
            ? d.mechanics
                .filter((m) => isFocused(m.abilityId, m.mine ?? refToMine(m.ref ?? m.t)))
                .map((m) => abilityName(m.abilityId))
            : [],
        )
        // 每段只有一種分類（與摘要、建議一致）；「以 Boss 為基準」是另外的說明標籤
        const kind = divergenceKind(d)
        const classes = [
          'divergence-card',
          kind === 'mechanic' && 'at-mechanic',
          kind === 'variant' && 'by-variant',
          i === active && 'active',
          focusedNames.size > 0 && 'focused',
        ]
        // 滑鼠提示只放資料（哪些機制不同）；分類的意義在站位摘要的「?」
        const variantTitle = d.variant
          ? [
              formatFightTime(d.variant.t),
              `我：${mechanicLabel(d.variant.mine, d.variant.ref, abilityName)}`,
              `參考：${mechanicLabel(d.variant.ref, d.variant.mine, abilityName)}`,
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
                {kind === 'untargetable' && <span className="tag">Boss 無法選中</span>}
                {kind === 'mirror' && <span className="tag">可能是{MIRROR_LABELS[d.mirror!]}站位</span>}
                {kind === 'mechanic' && <span className="tag mechanic">機制</span>}
                {kind === 'same-to-boss' && <span className="tag">相對 Boss 相同</span>}
                {kind === 'route' && <span className="card-sub">移動路線不同</span>}
                {d.bossFrame && <span className="tag">以 Boss 為基準</span>}
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
                        className={['card-mechanic', now && 'now', m.sameToBoss && 'same-to-boss', focusedNames.has(m.name) && 'focused']
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <span className="card-mechanic-name">{m.name}</span>
                        <span className="card-sub">
                          我 {m.mine !== undefined ? formatFightTime(m.mine) : '—'} · 參考 {m.ref !== undefined ? formatFightTime(m.ref) : '—'}
                        </span>
                        <span className="card-sub">
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
