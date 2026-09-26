import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { evaluateWindows, timelineWindow } from '../analysis/windows'
import { ruleIds, ruleName, windowRules, type WindowRule } from '../jobs/windows'
import { Playback } from './Playback'
import { StatusPanel } from './StatusPanel'
import { Windows } from './Windows'
import { buildAlignment } from '../analysis/alignment'
import { generateAdvice } from '../analysis/advice'
import { mechanicDifferences } from '../analysis/mechanics'
import { abilityUsage, gcdStats, lostGcdWindows } from '../analysis/metrics'
import { attachMechanics, compareTracks, distanceAt, divergences } from '../analysis/positions'
import { formatFightTime } from '../analysis/timeline'
import { fetchAbilityNames, type AbilityName } from '../fflogs/client'
import { abilityMap } from '../fflogs/report'
import { getJob } from '../jobs'
import { abilityCategory } from '../jobs/roleActions'
import { clipSide, incompatibility, loadSide, withoutAbilities, type Selection, type SideData } from './load'
import { AdviceList } from './AdviceList'
import { Mechanics } from './Mechanics'
import { Metrics } from './Metrics'
import { Positions } from './Positions'
import { Timeline } from './Timeline'

// 錨點太少時對齊結果不可靠
const MIN_ANCHORS = 5
// 兩人距離超過此值（yalm）視為站位不同
const DIVERGENCE_YALM = 8

function selectionKey(s: Selection): string {
  return `${s.report.code}/${s.fight.id}/${s.player.id}`
}

function useSides(mine: Selection, reference: Selection) {
  const [result, setResult] = useState<{ key: string; sides?: [SideData, SideData]; error?: string } | null>(null)
  const key = `${selectionKey(mine)}|${selectionKey(reference)}`
  // 只在選擇的戰鬥或角色改變時重新載入；Boss 繁中名稱晚到會換掉 Selection 物件，但資料不變
  const latest = useRef({ mine, reference })
  useLayoutEffect(() => {
    latest.current = { mine, reference }
  })

  useEffect(() => {
    const controller = new AbortController()
    const { mine, reference } = latest.current
    Promise.all([loadSide(mine, controller.signal), loadSide(reference, controller.signal)])
      .then((sides) => setResult({ key, sides }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setResult({ key, error: err instanceof Error ? err.message : String(err) })
      })
    return () => controller.abort()
  }, [key])

  return result?.key === key ? result : null
}

/** 查詢兩邊出現過的技能的繁中名稱；查詢失敗時沿用 FFLogs 的英文名稱。 */
function useAbilityNames(mine: SideData, reference: SideData): Map<number, AbilityName> {
  const [names, setNames] = useState<Map<number, AbilityName>>(new Map())
  useEffect(() => {
    const ids = [
      ...[mine, reference].flatMap((s) => [
        ...[...s.playerCasts, ...s.autoAttacks, ...s.bossCasts].map((c) => c.abilityId),
        // 效果（開打前、技能窗口）
        ...s.prepull,
        ...s.buffs.map((b) => b.statusId),
        // 當下狀態面板：角色自身的效果
        ...s.auras.filter((a) => a.sourceId === s.selection.player.id).map((a) => a.statusId),
      ]),
      // 技能窗口規則中的技能：兩邊都沒用過的（例如「缺少」的技能）不在報告的技能清單中
      ...windowRules(reference.selection.player.subType).flatMap(ruleIds),
    ]
    const controller = new AbortController()
    fetchAbilityNames(ids, controller.signal)
      .then(setNames)
      .catch((err: unknown) => {
        if (!controller.signal.aborted) console.warn('技能名稱查詢失敗，沿用英文名稱', err)
      })
    return () => controller.abort()
  }, [mine, reference])
  return names
}

function SummaryTable({
  mine,
  reference,
  mineEnd,
  refEnd,
  abilityName,
}: {
  mine: SideData
  reference: SideData
  /** 各自時間下的比較範圍結束點 */
  mineEnd: number
  refEnd: number
  abilityName: (id: number) => string
}) {
  const sides = [
    { key: 'mine', label: '我', side: mine, end: mineEnd },
    { key: 'ref', label: '參考', side: reference, end: refEnd },
  ]
  // 玩家、戰鬥、結果與長度已在上方的選單顯示，這裡只列比較才有的資訊
  const rows: { label: string; cell: (s: SideData, end: number) => ReactNode }[] = [
    {
      label: '比較範圍',
      cell: (s, end) => (
        <>
          0:00～{formatFightTime(end)}
          {s.duration - end >= 1000 && (
            <span className="hint-inline">（之後 {((s.duration - end) / 1000).toFixed(1)} 秒不列入統計）</span>
          )}
        </>
      ),
    },
    {
      // FFLogs 沒有開打前的施放事件，以開打當下身上的自身效果推知；對方沒有的效果標示出來
      label: '開打前',
      cell: (s) => {
        const other = s === mine ? reference : mine
        if (s.prepull.length === 0) return <span className="hint-inline">—</span>
        return s.prepull.map((id, i) => (
          <span key={id}>
            {i > 0 && '、'}
            <span
              className={other.prepull.includes(id) ? undefined : 'prepull-only'}
              title={other.prepull.includes(id) ? undefined : `${s === mine ? '參考' : '你'}開打時沒有這個效果`}
            >
              {abilityName(id)}
            </span>
          </span>
        ))
      },
    },
  ]
  return (
    <table className="summary-table">
      <thead>
        <tr>
          <th />
          {sides.map((s) => (
            <th key={s.key} className={s.key}>
              {s.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th>{row.label}</th>
            {sides.map((s) => (
              <td key={s.key}>{row.cell(s.side, s.end)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Loaded({ mine: mineLoaded, reference: refLoaded }: { mine: SideData; reference: SideData }) {
  const job = getJob(refLoaded.selection.player.subType)
  // 不需紀錄的技能（挑釁、退避、坦姿開關）一開始就移除
  const category = useMemo(() => (id: number) => abilityCategory(id, job), [job])
  const mine = useMemo(() => withoutAbilities(mineLoaded, (id) => category(id) === 'ignored'), [mineLoaded, category])
  const reference = useMemo(() => withoutAbilities(refLoaded, (id) => category(id) === 'ignored'), [refLoaded, category])
  const alignment = useMemo(() => buildAlignment(mine.bossCasts, reference.bossCasts), [mine, reference])
  const zhNames = useAbilityNames(mine, reference)
  // 顯示用：有繁中名稱時取代 FFLogs 的英文名稱，英文保留在 englishName
  const abilities = useMemo(() => {
    const merged = new Map([...abilityMap(mine.selection.report), ...abilityMap(reference.selection.report)])
    for (const [id, ability] of merged) {
      const zh = zhNames.get(id)
      if (zh) merged.set(id, { ...ability, name: zh.name, englishName: ability.name })
    }
    return merged
  }, [mine, reference, zhNames])
  const drifts = alignment.anchors.map((a) => (a.ref - a.mine) / 1000)

  // 比較範圍：兩場戰鬥都還在進行的時段（參考時間 0～較短一方結束）。
  // 較長一方超出的部分沒有比較對象，不列入任何統計；時間軸仍完整顯示但標示為範圍外。
  const compareEnd = Math.min(reference.duration, alignment.mineToRef(mine.duration))
  const mineInRange = useMemo(
    () => clipSide(mine, Math.min(mine.duration, alignment.refToMine(compareEnd))),
    [mine, alignment, compareEnd],
  )
  const refInRange = useMemo(() => clipSide(reference, compareEnd), [reference, compareEnd])

  const { gcd, lost } = useMemo(() => {
    if (!job) return { gcd: null, lost: [] }
    const gcds = (side: SideData) => side.playerCasts.filter((c) => job.isGcd(c.abilityId)).map((c) => c.t)
    const mineGcds = gcds(mineInRange)
    const refGcds = gcds(refInRange)
    const stats = { mine: gcdStats(mineGcds), ref: gcdStats(refGcds) }
    const windows =
      stats.mine.gcdMs === null ? [] : lostGcdWindows(mineGcds, refGcds, alignment.mineToRef, stats.mine.gcdMs)
    return { gcd: stats, lost: windows }
  }, [mineInRange, refInRange, alignment, job])
  // 技能使用次數含普通攻擊（時間軸不畫）；次數多寡可反映是否離 Boss 太遠或停手
  const usage = useMemo(
    () =>
      abilityUsage(
        [...mineInRange.playerCasts, ...mineInRange.autoAttacks],
        [...refInRange.playerCasts, ...refInRange.autoAttacks],
        alignment.mineToRef,
      ),
    [mineInRange, refInRange, alignment],
  )
  const positions = useMemo(() => {
    const mineSamples = mineInRange.playerPositions.map((p) => ({ ...p, t: alignment.mineToRef(p.t) }))
    const track = compareTracks(mineSamples, refInRange.playerPositions, reference.bossPositions, compareEnd)
    // 標示每段差異期間、兩人仍相距超過門檻時結算的 Boss 機制（參考日誌的 Boss 施放）
    const found = attachMechanics(
      divergences(track, DIVERGENCE_YALM),
      refInRange.bossCasts,
      (t) => distanceAt(track, t),
      DIVERGENCE_YALM,
    )
    return { mineSamples, track, divergences: found }
  }, [mineInRange, refInRange, reference, alignment, compareEnd])
  const mechanics = useMemo(
    () =>
      mechanicDifferences(
        mine.bossCasts,
        reference.bossCasts,
        alignment.mineToRef,
        alignment.mineToRef(mine.duration),
        reference.duration,
      ),
    [mine, reference, alignment],
  )
  // 報告技能清單中沒有的（兩邊都沒用過）也用查到的繁中名稱
  const abilityName = useCallback(
    (id: number) => abilities.get(id)?.name ?? zhNames.get(id)?.name ?? `#${id}`,
    [abilities, zhNames],
  )
  // 技能窗口（xivanalysis 式的職業規則）：兩邊各自評分，只看比較範圍內
  const windows = useMemo(() => {
    if (!job) return []
    // 各自的 GCD 間隔用來依窗口長度封頂應打的 GCD 數
    const evaluate = (rule: WindowRule, side: SideData, gcdMs: number | null) =>
      evaluateWindows(rule, side.buffs, side.playerCasts, job.isGcd, abilityName, gcdMs, side.duration)
    return windowRules(job.subType).map((rule) => ({
      mine: evaluate(rule, mineInRange, gcd?.mine.gcdMs ?? null),
      ref: evaluate(rule, refInRange, gcd?.ref.gcdMs ?? null),
    }))
  }, [job, mineInRange, refInRange, abilityName, gcd])
  const advice = useMemo(
    () =>
      generateAdvice({
        mechanics,
        durationMs: compareEnd,
        gcd,
        lost,
        usage,
        divergences: positions.divergences,
        track: positions.track,
        abilityName,
        englishName: (id) => {
          const a = abilities.get(id)
          return a?.englishName ?? a?.name ?? `#${id}`
        },
        isGcd: job?.isGcd,
        category,
        mineToRef: alignment.mineToRef,
        firstUse: (id) => mineInRange.playerCasts.find((c) => c.abilityId === id)?.t,
        windows,
        prepull: { mine: mine.prepull, ref: reference.prepull },
      }),
    [compareEnd, gcd, lost, usage, positions, abilities, abilityName, job, category, alignment, mineInRange, mechanics, windows, mine, reference],
  )

  // 目前檢視的參考時間（站位圖、當下狀態、時間軸游標）
  const [cursor, setCursor] = useState(0)
  // 每次點擊都產生新物件，讓時間軸即使捲到同一時間也會重新捲動
  const [focus, setFocus] = useState<{ t: number } | null>(null)
  const [playing, setPlaying] = useState(false)
  // 預設 2 倍速播放
  const [speed, setSpeed] = useState(2)
  const jumpTo = useCallback((t: number) => {
    setCursor(t)
    setFocus({ t })
  }, [setCursor, setFocus])
  const playbackEnd = Math.max(reference.duration, alignment.mineToRef(mine.duration))
  // 時間軸的標示：固定下來，時間軸的技能列才不會在播放時重繪
  const timelineHighlights = useMemo(() => lost.map((w) => ({ start: w.refStart, end: w.refEnd })), [lost])
  const timelineWindows = useMemo(
    () =>
      windows.flatMap(({ mine: m, ref: r }) => [
        ...m.windows.map((w) => ({ ...timelineWindow(w, ruleName(m.rule, abilityName)), side: 'mine' as const })),
        ...r.windows.map((w) => ({ ...timelineWindow(w, ruleName(r.rule, abilityName)), side: 'ref' as const })),
      ]),
    [windows, abilityName],
  )

  // 不隨游標變動的區塊先做好，播放時游標每秒更新多次，不必跟著重繪
  const staticSections = useMemo(
    () => (
      <>
        <h3>建議</h3>
        <AdviceList advice={advice} onJump={jumpTo} />
        {windows.length > 0 && (
          <>
            <h3>技能窗口</h3>
            <Windows
              windows={windows}
              abilities={abilities}
              abilityName={abilityName}
              mineToRef={alignment.mineToRef}
              onJump={jumpTo}
            />
          </>
        )}
        <h3>Boss 機制差異</h3>
        <Mechanics differences={mechanics} abilityName={abilityName} onJump={jumpTo} />
        <Metrics gcd={gcd} usage={usage} abilities={abilities} job={job} category={category} lost={lost} onFocus={jumpTo} />
      </>
    ),
    [advice, jumpTo, windows, abilities, abilityName, alignment, mechanics, gcd, usage, job, category, lost],
  )

  return (
    <>
      <SummaryTable
        mine={mine}
        reference={reference}
        mineEnd={mineInRange.duration}
        refEnd={compareEnd}
        abilityName={abilityName}
      />
      <p className="hint">
        時間軸以 Boss 技能對齊：錨點 {alignment.anchors.length} 個
        {drifts.length > 0 &&
          `，參考相對於我的時間差 ${Math.min(...drifts).toFixed(1)} ～ ${Math.max(...drifts).toFixed(1)} 秒`}
        。兩場都在進行的時段才列入統計。
      </p>
      {alignment.anchors.length < MIN_ANCHORS && <p className="error">對齊錨點過少，時間軸對齊結果可能不準確。</p>}
      {!job && <p className="hint">此職業尚未有專屬規則，技能不區分 GCD／oGCD。</p>}
      {staticSections}
      <h3>站位與當下狀態</h3>
      <Positions
        abilityName={abilityName}
        track={positions.track}
        divergences={positions.divergences}
        mineSamples={positions.mineSamples}
        refSamples={refInRange.playerPositions}
        threshold={DIVERGENCE_YALM}
        duration={compareEnd}
        cursor={cursor}
        onSeek={setCursor}
        onJump={jumpTo}
        status={
          <StatusPanel
            mine={mine}
            reference={reference}
            cursor={cursor}
            refToMine={alignment.refToMine}
            bossCasts={reference.bossCasts}
            abilities={abilities}
            abilityName={abilityName}
          />
        }
      />
      <h3>時間軸</h3>
      <Timeline
        mine={mine}
        reference={reference}
        alignment={alignment}
        abilities={abilities}
        job={job}
        highlights={timelineHighlights}
        windows={timelineWindows}
        focus={focus}
        cursor={cursor}
        follow={playing}
        onSeek={setCursor}
        compareEnd={compareEnd}
      />
      {/* 固定在畫面底部的播放列：捲到哪裡都能操作 */}
      <Playback
        cursor={cursor}
        duration={playbackEnd}
        playing={playing}
        speed={speed}
        onSeek={setCursor}
        onPlayingChange={setPlaying}
        onSpeedChange={setSpeed}
      />
    </>
  )
}

function ComparisonLoader({ mine, reference }: { mine: Selection; reference: Selection }) {
  const result = useSides(mine, reference)
  // 事件只依選擇的 ID 載入一次；顯示用的名稱（Boss 繁中名稱可能晚到）取目前的選擇
  const sides = useMemo(
    () =>
      result?.sides && ([
        { ...result.sides[0], selection: mine },
        { ...result.sides[1], selection: reference },
      ] as const),
    [result, mine, reference],
  )
  if (!result) return <p>載入戰鬥事件中…</p>
  if (result.error || !sides) return <p className="error">{result.error}</p>
  return <Loaded mine={sides[0]} reference={sides[1]} />
}

export function Comparison({ mine, reference }: { mine: Selection; reference: Selection }) {
  const problem = incompatibility(mine, reference)
  if (problem) return <p className="error">{problem}</p>
  return <ComparisonLoader mine={mine} reference={reference} />
}
