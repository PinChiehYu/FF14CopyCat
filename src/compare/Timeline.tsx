import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { pushTitle, type Alignment, type PushDifference, type TimedCast } from '../analysis/alignment'
import { displayAxis, type DisplayAxis } from '../analysis/displayAxis'
import { formatFightTime } from '../analysis/timeline'
import { raidBuffAction, raidBuffLabel, raidBuffsAt, type RaidBuffWindow } from '../analysis/raidBuffs'
import { abilityIconUrl } from '../fflogs/report'
import type { Ability } from '../fflogs/types'
import type { JobModule } from '../jobs'
import type { SideData } from './load'
import type { TimelineWindow } from '../analysis/windows'
import { HelpTip } from './HelpTip'
import { useRefLabel } from './refLabel'
import { isRangedFiller, lossFillerTimes } from '../jobs/rangedFillers'

const ZOOM_LEVELS = [10, 20, 40, 80] // 每秒像素
// 「比較範圍外」標示在一行內需要的寬度（像素）；範圍外的區域比這窄時改放在虛線左側
const OUT_OF_RANGE_LABEL_PX = 90

/** 時間軸上標示的穿插過多（該側自己的戰鬥時間） */
export interface WeaveMark {
  side: 'mine' | 'ref'
  start: number
  end: number
  title: string
}

/** 時間軸只標覆蓋掉至少這麼多的提早續上（一個 GCD 內續上是正常打法） */
export const DOT_CLIP_MARK_MIN_MS = 3000

/** 時間軸上標示的 DoT 斷掉時段（gap）與提早續上（clip，start＝續上的時間）；該側自己的戰鬥時間 */
export interface DotMark {
  side: 'mine' | 'ref'
  kind: 'gap' | 'clip'
  start: number
  end: number
  title: string
}

interface Lane {
  label: string
  side: 'mine' | 'ref'
  /** t：顯示時間；original：該側自己的戰鬥時間；aligned：對齊後的參考時間；consistency：前輩平均的一致度（0～1） */
  casts: { t: number; original: number; aligned: number; abilityId: number; consistency?: number }[]
}

function lanes(
  side: SideData,
  label: string,
  key: Lane['side'],
  job: JobModule | undefined,
  toDisplay: (t: number) => number,
  toRef: (t: number) => number,
): Lane[] {
  const casts = side.playerCasts.map((c) => ({
    t: toDisplay(c.t),
    original: c.t,
    aligned: toRef(c.t),
    abilityId: c.abilityId,
    consistency: (c as TimedCast & { consistency?: number }).consistency,
  }))
  if (!job) return [{ label, side: key, casts }]
  return [
    { label: `${label} GCD`, side: key, casts: casts.filter((c) => job.isGcd(c.abilityId)) },
    { label: `${label} oGCD`, side: key, casts: casts.filter((c) => !job.isGcd(c.abilityId)) },
  ]
}

/** 團隊 Buff 的數量變化：每段時間有效的團隊 Buff（數量不變的一段） */
function raidBuffSegments(windows: RaidBuffWindow[]): { start: number; end: number; names: string[] }[] {
  const points = [...new Set(windows.flatMap((w) => [w.start, w.end]))].sort((a, b) => a - b)
  const segments: { start: number; end: number; names: string[] }[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const names = raidBuffsAt(windows, points[i])
    if (names.length > 0) segments.push({ start: points[i], end: points[i + 1], names })
  }
  return segments
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
  reference,
  alignment,
  abilities,
  job,
  highlights = [],
  windows = [],
  weaveMarks = [],
  dotMarks = [],
  isFocused = null,
  pushes = [],
  focus = null,
  cursor,
  follow = false,
  onSeek,
  compareEnd,
  averaged = false,
  raidBuffs,
}: {
  mine: SideData
  /** 還沒有參考日誌時為 null：Boss 列用我的 Boss 施放、只畫我的技能列（alignment 應為恆等對應） */
  reference: SideData | null
  alignment: Alignment
  abilities: Map<number, Ability>
  job: JobModule | undefined
  /** 我的戰鬥時間的區段（例如少打 GCD 的時段），畫在我的列上 */
  highlights?: { start: number; end: number }[]
  /** 技能窗口（各側自己的戰鬥時間），畫在該側 GCD 列的底部 */
  windows?: (TimelineWindow & { side: 'mine' | 'ref' })[]
  /** 穿插過多（各側自己的戰鬥時間）：前一個 GCD 到被延後的 GCD */
  weaveMarks?: WeaveMark[]
  /** DoT 斷掉與提早續上（各側自己的戰鬥時間），畫在該側 GCD 列的頂部 */
  dotMarks?: DotMark[]
  /** 關注的機制時間點（技能 ID、我的時間；見 focusedMechanics.ts），Boss 列高光；沒有選擇時為 null */
  isFocused?: ((abilityId: number, mineT: number) => boolean) | null
  /** 推進差距（例如轉場）：兩邊各自照實際長度排開，較快的一方補上空白 */
  pushes?: PushDifference[]
  /** 要捲動到的參考時間；每次傳入新物件就會捲動一次 */
  focus?: { t: number } | null
  /** 目前檢視的參考時間，畫成直線 */
  cursor?: number
  /** 播放中：游標超出可見範圍時自動捲動 */
  follow?: boolean
  /** 點擊時間尺時移動游標（參考時間） */
  onSeek?: (t: number) => void
  /** 比較範圍結束（參考時間）；之後的部分標示為範圍外 */
  compareEnd?: number
  /** 參考為前輩平均（已在我的時間、Boss 列為我的；圖示透明度表示一致度） */
  averaged?: boolean
  /** 我身上的團隊 Buff（我的時間）；有時在我的技能列下方多一列 */
  raidBuffs?: RaidBuffWindow[]
}) {
  const refLabel = useRefLabel()
  const [pxPerSec, setPxPerSec] = useState(20)
  // 時間尺與 Boss 列的依據：參考日誌；還沒有參考時用我的
  const ref = reference ?? mine
  const x = (ms: number) => (ms / 1000) * pxPerSec
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const axis = useMemo(() => displayAxis(pushes, alignment.mineToRef), [pushes, alignment])

  useEffect(() => {
    if (!focus || !scrollRef.current) return
    // 內層立即捲動：同時對外層做平滑捲動時，瀏覽器會中斷內層的平滑捲動
    scrollRef.current.scrollLeft = Math.max(0, (axis.ref(focus.t) / 1000) * pxPerSec - 120)
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    // 只在 focus 改變時捲動；縮放時不重捲
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

  // 播放中游標固定在左側四分之一處，時間軸跟著連續捲動（原本碰到右緣才一次跳回，手機上時間軸窄，約 10 秒就跳一大段）
  useEffect(() => {
    const el = scrollRef.current
    if (!follow || cursor === undefined || !el) return
    const cx = (axis.ref(cursor) / 1000) * pxPerSec
    el.scrollLeft = Math.max(0, cx - el.clientWidth * 0.25)
  }, [follow, cursor, pxPerSec, axis])

  const totalMs = Math.max(axis.ref(ref.duration), axis.mine(mine.duration))
  const width = x(totalMs) + 40

  // 算止損的止損技施放（各側的戰鬥時間；開場起手與強化效果中的不算）
  const fillers = useMemo(() => {
    const isGcd = (id: number) => (job ? job.isGcd(id) : true)
    return { mine: lossFillerTimes(mine, isGcd), ref: reference ? lossFillerTimes(reference, isGcd) : new Set<number>() }
  }, [mine, reference, job])
  const allLanes = useMemo(
    () => [
      // 列名欄窄：前輩平均簡稱「平均」
      ...(reference ? lanes(reference, averaged ? '平均' : refLabel, 'ref', job, axis.ref, (t) => t) : []),
      ...lanes(mine, '我', 'mine', job, axis.mine, alignment.mineToRef),
    ],
    [reference, mine, job, alignment, axis, refLabel, averaged],
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
        <HelpTip
          text={[
            reference && !averaged && '時間軸以參考日誌為準；我的施放已依 Boss 機制對齊。',
            reference && !averaged && '一方推進較慢時兩邊照實際長度排開，較快的一方以斜線補上空白。',
            averaged &&
              '前輩平均：每位前輩的施放依 Boss 機制換算成你的時間，GCD 取每個位置最常見的技能、能力技取過半數前輩有用的時間（中位數）。圖示越淡代表前輩之間越不一致（該位置用這個技能的比例），滑鼠停在圖示上可看比例。',
            '灰底為 Boss 無法選中。滑鼠停在圖示上可看技能與原始時間。',
            '能力技列頂部的紅線：穿插過多，下一個 GCD 被延後（從前一個 GCD 到被延後的 GCD）。',
            dotMarks.length > 0 && `GCD 列頂部的金黃線：DoT 斷掉（Boss 可選中但 DoT 不在敵人身上，1 秒以上）；金黃短直線：DoT 提早續上（覆蓋掉 ${DOT_CLIP_MARK_MIN_MS / 1000} 秒以上）。`,
            'Boss 列較粗的深藍色標記：你在「搜尋前輩日誌」中關注的機制時間點（有取消勾選時才標）。',
            raidBuffs && '「團隊 Buff」列：你身上的團隊 Buff 與敵人身上的連環計、介毒之術，圖示為隊友施放的技能（放在開始的時間），顏色越深代表同時越多個；滑鼠停在上面可看是哪些。爆發技能應落在顏色最深的時段。',
            '金黃框：止損技（近戰與坦克離開 Boss 時用的遠程 GCD，例如投盾、飛刀）；用得多代表離 Boss 太遠或走位不順。開場起手（開打前與第一個 GCD）與有強化效果時（貫穿尖、勾刃、燕飛效果提高）不標。',
          ]
            .filter(Boolean)
            .join('\n')}
        />
      </div>

      <div className="timeline-body">
        <div className="timeline-labels">
          <div className="lane-label ruler-label">時間</div>
          {/* 與「參考 GCD」等列名同格式（手機的列名欄窄，「Boss（參考）」會超出） */}
          <div className="lane-label">{reference && !averaged ? `${refLabel} Boss` : 'Boss'}</div>
          {allLanes.map((lane) => (
            <div key={lane.label} className={`lane-label ${lane.side}`}>
              {lane.label}
            </div>
          ))}
          {raidBuffs && <div className="lane-label mine raid-label">團隊 Buff</div>}
        </div>

        <div className="timeline-scroll" ref={scrollRef}>
          <div className="timeline-canvas" style={{ width }}>
            {cursor !== undefined && <span className="timeline-cursor" style={{ left: x(axis.ref(cursor)) }} />}
            {compareEnd !== undefined && totalMs - axis.ref(compareEnd) >= 1000 && (
              <span
                // 範圍外的區域太窄、放不下標示時，標示改放在虛線左側（不在窄區域內拆成多行）
                className={`out-of-range${width - x(axis.ref(compareEnd)) < OUT_OF_RANGE_LABEL_PX ? ' narrow' : ''}`}
                style={{ left: x(axis.ref(compareEnd)) }}
                title="超出比較範圍：另一方的戰鬥已結束，不列入統計"
              >
                <span className="out-of-range-label">比較範圍外</span>
              </span>
            )}
            <TimelineLanes
              mine={mine}
              reference={ref}
              alignment={alignment}
              axis={axis}
              abilities={abilities}
              allLanes={allLanes}
              fillers={fillers}
              highlights={highlights}
              windows={windows}
              weaveMarks={weaveMarks}
              dotMarks={dotMarks}
              isFocused={isFocused}
              pxPerSec={pxPerSec}
              totalMs={totalMs}
              onSeek={onSeek}
              raidBuffs={raidBuffs}
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
  axis,
  abilities,
  allLanes,
  fillers,
  highlights,
  windows,
  weaveMarks,
  dotMarks,
  isFocused,
  pxPerSec,
  totalMs,
  onSeek,
  raidBuffs,
}: {
  mine: SideData
  reference: SideData
  alignment: Alignment
  axis: DisplayAxis
  abilities: Map<number, Ability>
  allLanes: Lane[]
  /** 算止損的止損技施放時間（各側的戰鬥時間） */
  fillers: { mine: Set<number>; ref: Set<number> }
  highlights: { start: number; end: number }[]
  windows: (TimelineWindow & { side: 'mine' | 'ref' })[]
  weaveMarks: WeaveMark[]
  dotMarks: DotMark[]
  isFocused: ((abilityId: number, mineT: number) => boolean) | null
  pxPerSec: number
  totalMs: number
  onSeek?: (t: number) => void
  raidBuffs?: RaidBuffWindow[]
}) {
  const x = (ms: number) => (ms / 1000) * pxPerSec
  const anchorRefTimes = new Set(alignment.anchors.map((a) => a.ref))
  const name = (id: number) => abilities.get(id)?.name ?? `#${id}`
  const ticks = Array.from({ length: Math.floor(ref.duration / 10_000) + 1 }, (_, i) => i * 10_000)
  const sideOf = (side: Lane['side']) => (side === 'mine' ? mine : ref)
  const toDisplay = (side: Lane['side']) => (side === 'mine' ? axis.mine : axis.ref)
  const span = (start: number, end: number) => ({ left: x(start), width: Math.max(2, x(end - start)) })

  // 推進差距：較快的一方補上的空白（斜線）
  const gaps = (side: Lane['side']) =>
    axis.gaps
      .filter((g) => g.side === side)
      .map((g) => (
        <span
          key={`gap-${g.start}`}
          className="timeline-gap"
          style={span(g.start, g.end)}
          title={`${side === 'ref' ? '參考' : '你'}已推進，這段空白是${side === 'ref' ? '你' : '參考'}多花的時間。${pushTitle(g.push)}`}
        />
      ))
  // Boss 無法選中的時段（該側自己的時間）
  const untargetable = (side: Lane['side']) =>
    sideOf(side).untargetable.map((u) => (
      <span
        key={`untargetable-${u.start}`}
        className="untargetable"
        style={span(toDisplay(side)(u.start), toDisplay(side)(u.end))}
        title={`Boss 無法選中（${side === 'ref' ? '參考' : '我'} ${formatFightTime(u.start)}～${formatFightTime(u.end)}）`}
      />
    ))

  return (
    <>
            <div
              className="lane ruler"
              title="點擊以移動站位圖的時間"
              onClick={(e) => onSeek?.(axis.toRef(((e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerSec) * 1000))}
            >
              {ticks.map((t) => (
                <span key={t} className="tick" style={{ left: x(axis.ref(t)) }}>
                  {formatFightTime(t).replace(/\.\d$/, '')}
                </span>
              ))}
            </div>

            <div className="lane boss">
              {untargetable('ref')}
              {gaps('ref')}
              {dedupeBoss(ref.bossCasts).map((c, i) => {
                // 關注的機制時間點：參考的施放換成我的時間判斷
                const focused = !!isFocused?.(c.abilityId, alignment.refToMine(c.t))
                return (
                  <span
                    key={i}
                    className={['boss-cast', anchorRefTimes.has(c.t) && 'anchor', focused && 'focused'].filter(Boolean).join(' ')}
                    style={{ left: x(axis.ref(c.t)) }}
                    title={`${name(c.abilityId)} ${formatFightTime(c.t)}${anchorRefTimes.has(c.t) ? '（對齊錨點）' : ''}`}
                  />
                )
              })}
              {/* 推進差距：從推進開始到兩邊都推進完成 */}
              {axis.gaps.map((g) => (
                <span
                  key={g.push.refEnd}
                  className={`push-marker ${g.push.deltaMs > 0 ? 'slower' : 'faster'}`}
                  style={{ left: x(axis.ref(g.push.refStart)), minWidth: Math.max(4, x(g.end - axis.ref(g.push.refStart))) }}
                  title={pushTitle(g.push)}
                >
                  我{g.push.deltaMs > 0 ? '慢' : '快'} {(Math.abs(g.push.deltaMs) / 1000).toFixed(1)} 秒
                </span>
              ))}
            </div>

            {allLanes.map((lane, laneIndex) => {
              const first = allLanes.findIndex((l) => l.side === lane.side) === laneIndex
              const at = toDisplay(lane.side)
              return (
              <div key={lane.label} className={`lane ${lane.side}`}>
                {untargetable(lane.side)}
                {gaps(lane.side)}
                {/* 技能窗口畫在每側的第一列（GCD 列）底部 */}
                {first &&
                  windows
                    .filter((w) => w.side === lane.side)
                    .map((w) => (
                      <span
                        key={`${w.start}-${w.title}`}
                        className={`window-bar ${w.state}`}
                        style={span(at(w.start), at(w.end))}
                        title={w.title}
                      />
                    ))}
                {/* DoT 斷掉（線）與提早續上（短直線）：畫在每側第一列（GCD 列）頂部 */}
                {first &&
                  dotMarks
                    .filter((d) => d.side === lane.side)
                    .map((d) =>
                      d.kind === 'gap' ? (
                        <span key={`dot-gap-${d.start}-${d.title}`} className="dot-gap" style={span(at(d.start), at(d.end))} title={d.title} />
                      ) : (
                        <span key={`dot-clip-${d.start}-${d.title}`} className="dot-clip-mark" style={{ left: x(at(d.start)) }} title={d.title} />
                      ),
                    )}
                {/* 穿插過多：畫在每側最後一列（能力技列）頂部，從前一個 GCD 到被延後的 GCD */}
                {allLanes.findLastIndex((l) => l.side === lane.side) === laneIndex &&
                  weaveMarks
                    .filter((w) => w.side === lane.side)
                    .map((w) => (
                      <span key={`weave-${w.start}`} className="weave-bar" style={span(at(w.start), at(w.end))} title={w.title} />
                    ))}
                {lane.side === 'mine' &&
                  highlights.map((h) => (
                    <span key={h.start} className="highlight" style={span(at(h.start), at(h.end))} title="少打 GCD 的時段" />
                  ))}
                {lane.casts.map((c, i) => {
                  const ability = abilities.get(c.abilityId)
                  const time =
                    lane.side === 'mine'
                      ? `${formatFightTime(c.original)}（對齊後 ${formatFightTime(c.aligned)}）`
                      : formatFightTime(c.original)
                  const filler = isRangedFiller(c.abilityId) && fillers[lane.side].has(c.original)
                  // 前輩平均：一致度越低越淡（最淡 25%），滑鼠提示附上比例
                  const consistency = c.consistency === undefined ? '' : `・${Math.round(c.consistency * 100)}% 前輩`
                  const style = { left: x(c.t), ...(c.consistency === undefined ? {} : { opacity: 0.25 + 0.75 * c.consistency }) }
                  return ability ? (
                    <img
                      key={i}
                      className={filler ? 'cast filler' : 'cast'}
                      src={abilityIconUrl(ability.icon)}
                      alt={ability.name}
                      title={`${ability.name}${ability.englishName ? `（${ability.englishName}）` : ''}${filler ? '・止損技' : ''} ${time}${consistency}`}
                      loading="lazy"
                      style={style}
                    />
                  ) : (
                    <span key={i} className="cast unknown" title={`${name(c.abilityId)} ${time}${consistency}`} style={style} />
                  )
                })}
                {/* 死亡：每側第一列標 ✕，死亡到恢復行動之間畫斜線區段 */}
                {first &&
                  sideOf(lane.side).deaths.map((d) => {
                    const start = at(d.t)
                    const end = at(d.revivedAt ?? sideOf(lane.side).duration)
                    const cause = d.abilityId !== null ? `被「${name(d.abilityId)}」擊殺` : '死亡'
                    return (
                      <span key={`death-${d.t}`}>
                        <span className="dead-span" style={span(start, end)} title={`死亡中（${cause}）`} />
                        <span className="death-marker" style={{ left: x(start) }} title={`${formatFightTime(d.t)} 死亡：${cause}`}>
                          ✕
                        </span>
                      </span>
                    )
                  })}
                {lane.side === 'mine' && axis.mine(mine.duration) < totalMs && (
                  <span className="end-marker" style={{ left: x(axis.mine(mine.duration)) }} title="我的戰鬥結束" />
                )}
              </div>
              )
            })}
            {raidBuffs && (
              <RaidBuffLane
                windows={raidBuffs}
                at={axis.mine}
                x={x}
                span={span}
                label={raidBuffLabel(raidBuffs, (id) => abilities.get(id)?.name)}
                action={raidBuffAction(abilities)}
              />
            )}
    </>
  )
}

/** 團隊 Buff 列：同時越多個顏色越深；每個團隊 Buff 開始的地方放隊友施放的技能圖示 */
function RaidBuffLane({
  windows,
  at,
  x,
  span,
  label,
  action,
}: {
  windows: RaidBuffWindow[]
  /** 英文名稱 → 顯示名稱（繁中） */
  label: (name: string) => string
  /** 英文名稱 → 團隊 Buff 的技能（圖示用）；找不到時不放圖示 */
  action: (name: string) => Ability | undefined
  at: (t: number) => number
  x: (t: number) => number
  span: (start: number, end: number) => { left: number; width: number }
}) {
  const segments = raidBuffSegments(windows)
  const most = Math.max(1, ...segments.map((s) => s.names.length))
  return (
    <div className="lane mine raid-lane">
      {segments.map((s) => (
        <span
          key={s.start}
          className="raid-segment"
          style={{ ...span(at(s.start), at(s.end)), opacity: 0.25 + (0.75 * s.names.length) / most }}
          title={`團隊 Buff ${s.names.length} 個：${s.names.map(label).join('、')}（${formatFightTime(s.start)}～${formatFightTime(s.end)}）`}
        />
      ))}
      {windows.map((w) => {
        const ability = action(w.name)
        return (
          ability && (
            <img
              key={`${w.name}-${w.start}`}
              className="raid-cast"
              src={abilityIconUrl(ability.icon)}
              alt={label(w.name)}
              title={`${label(w.name)} ${formatFightTime(w.start)}～${formatFightTime(w.end)}`}
              loading="lazy"
              style={{ left: x(at(w.start)) }}
            />
          )
        )
      })}
    </div>
  )
}

const TimelineLanes = memo(TimelineLanesImpl)
