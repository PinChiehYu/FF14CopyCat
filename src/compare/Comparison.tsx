import { useEffect, useMemo, useState } from 'react'
import { buildAlignment } from '../analysis/alignment'
import { generateAdvice } from '../analysis/advice'
import { mechanicDifferences } from '../analysis/mechanics'
import { abilityUsage, gcdStats, lostGcdWindows } from '../analysis/metrics'
import { compareTracks, divergences } from '../analysis/positions'
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

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([loadSide(mine, controller.signal), loadSide(reference, controller.signal)])
      .then((sides) => setResult({ key, sides }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setResult({ key, error: err instanceof Error ? err.message : String(err) })
      })
    return () => controller.abort()
  }, [mine, reference, key])

  return result?.key === key ? result : null
}

/** 查詢兩邊出現過的技能的繁中名稱；查詢失敗時沿用 FFLogs 的英文名稱。 */
function useAbilityNames(mine: SideData, reference: SideData): Map<number, AbilityName> {
  const [names, setNames] = useState<Map<number, AbilityName>>(new Map())
  useEffect(() => {
    const ids = [mine, reference].flatMap((s) => [...s.playerCasts, ...s.autoAttacks, ...s.bossCasts].map((c) => c.abilityId))
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

function killLabel(side: SideData): string {
  return side.selection.fight.kill ? '（擊殺）' : '（滅團）'
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
  const duration = Math.max(reference.duration, alignment.mineToRef(mine.duration))
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
    return { mineSamples, track, divergences: divergences(track, DIVERGENCE_YALM) }
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
  const abilityName = (id: number) => abilities.get(id)?.name ?? `#${id}`
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
        abilityName: (id) => abilities.get(id)?.name ?? `#${id}`,
        englishName: (id) => {
          const a = abilities.get(id)
          return a?.englishName ?? a?.name ?? `#${id}`
        },
        isGcd: job?.isGcd,
        category,
        mineToRef: alignment.mineToRef,
        firstUse: (id) => mineInRange.playerCasts.find((c) => c.abilityId === id)?.t,
      }),
    [compareEnd, gcd, lost, usage, positions, abilities, job, category, alignment, mineInRange, mechanics],
  )

  // 目前檢視的參考時間（站位圖、時間軸游標）
  const [cursor, setCursor] = useState(0)
  // 每次點擊都產生新物件，讓時間軸即使捲到同一時間也會重新捲動
  const [focus, setFocus] = useState<{ t: number } | null>(null)
  const jumpTo = (t: number) => {
    setCursor(t)
    setFocus({ t })
  }

  return (
    <>
      <dl className="summary">
        <dt>戰鬥長度</dt>
        <dd>
          我 {formatFightTime(mine.duration)}
          {killLabel(mine)}／參考 {formatFightTime(reference.duration)}
          {killLabel(reference)}
        </dd>
        <dt>比較範圍</dt>
        <dd>
          參考 0:00～{formatFightTime(compareEnd)}（我的 0:00～{formatFightTime(mineInRange.duration)}）
          {duration - compareEnd >= 1000 &&
            `；${reference.duration > compareEnd ? '參考' : '我'}之後的 ${((duration - compareEnd) / 1000).toFixed(1)} 秒沒有比較對象，不列入統計`}
        </dd>
        <dt>對齊錨點</dt>
        <dd>
          {alignment.anchors.length} 個
          {drifts.length > 0 &&
            `；參考相對於我的時間差 ${Math.min(...drifts).toFixed(1)} ～ ${Math.max(...drifts).toFixed(1)} 秒`}
        </dd>
      </dl>
      {alignment.anchors.length < MIN_ANCHORS && <p className="error">對齊錨點過少，時間軸對齊結果可能不準確。</p>}
      {!job && <p className="hint">此職業尚未有專屬規則，技能不區分 GCD／oGCD。</p>}
      <h3>建議</h3>
      <AdviceList advice={advice} onJump={jumpTo} />
      <h3>Boss 機制差異</h3>
      <Mechanics differences={mechanics} abilityName={abilityName} onJump={jumpTo} />
      <Metrics
        gcd={gcd}
        usage={usage}
        abilities={abilities}
        job={job}
        category={category}
        lost={lost}
        onFocus={jumpTo}
      />
      <h3>站位比較</h3>
      <Positions
        track={positions.track}
        divergences={positions.divergences}
        mineSamples={positions.mineSamples}
        refSamples={refInRange.playerPositions}
        threshold={DIVERGENCE_YALM}
        duration={compareEnd}
        cursor={cursor}
        onSeek={setCursor}
        onJump={jumpTo}
      />
      <h3>時間軸</h3>
      <Timeline
        mine={mine}
        reference={reference}
        alignment={alignment}
        abilities={abilities}
        job={job}
        highlights={lost.map((w) => ({ start: w.refStart, end: w.refEnd }))}
        focus={focus}
        cursor={cursor}
        onSeek={setCursor}
        compareEnd={compareEnd}
      />
    </>
  )
}

function ComparisonLoader({ mine, reference }: { mine: Selection; reference: Selection }) {
  const result = useSides(mine, reference)
  if (!result) return <p>載入戰鬥事件中…</p>
  if (result.error || !result.sides) return <p className="error">{result.error}</p>
  return <Loaded mine={result.sides[0]} reference={result.sides[1]} />
}

export function Comparison({ mine, reference }: { mine: Selection; reference: Selection }) {
  const problem = incompatibility(mine, reference)
  if (problem) return <p className="error">{problem}</p>
  return <ComparisonLoader mine={mine} reference={reference} />
}
