import { useEffect, useMemo, useState } from 'react'
import { buildAlignment } from '../analysis/alignment'
import { gcdStats, lostGcdWindows } from '../analysis/metrics'
import { compareTracks, divergences } from '../analysis/positions'
import { formatFightTime } from '../analysis/timeline'
import { abilityMap } from '../fflogs/report'
import { getJob } from '../jobs'
import { incompatibility, loadSide, type Selection, type SideData } from './load'
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

function killLabel(side: SideData): string {
  return side.selection.fight.kill ? '（擊殺）' : '（滅團）'
}

function Loaded({ mine, reference }: { mine: SideData; reference: SideData }) {
  const alignment = useMemo(() => buildAlignment(mine.bossCasts, reference.bossCasts), [mine, reference])
  const abilities = useMemo(
    () => new Map([...abilityMap(mine.selection.report), ...abilityMap(reference.selection.report)]),
    [mine, reference],
  )
  const job = getJob(reference.selection.player.subType)
  const drifts = alignment.anchors.map((a) => (a.ref - a.mine) / 1000)
  const lost = useMemo(() => {
    if (!job) return []
    const gcds = (side: SideData) => side.playerCasts.filter((c) => job.isGcd(c.abilityId)).map((c) => c.t)
    const mineGcds = gcds(mine)
    const { gcdMs } = gcdStats(mineGcds)
    return gcdMs === null ? [] : lostGcdWindows(mineGcds, gcds(reference), alignment.mineToRef, gcdMs)
  }, [mine, reference, alignment, job])
  const duration = Math.max(reference.duration, alignment.mineToRef(mine.duration))
  const positions = useMemo(() => {
    const mineSamples = mine.playerPositions.map((p) => ({ ...p, t: alignment.mineToRef(p.t) }))
    const track = compareTracks(mineSamples, reference.playerPositions, reference.bossPositions, duration)
    return { mineSamples, track, divergences: divergences(track, DIVERGENCE_YALM) }
  }, [mine, reference, alignment, duration])

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
        <dt>對齊錨點</dt>
        <dd>
          {alignment.anchors.length} 個
          {drifts.length > 0 &&
            `；參考相對於我的時間差 ${Math.min(...drifts).toFixed(1)} ～ ${Math.max(...drifts).toFixed(1)} 秒`}
        </dd>
      </dl>
      {alignment.anchors.length < MIN_ANCHORS && <p className="error">對齊錨點過少，時間軸對齊結果可能不準確。</p>}
      {!job && <p className="hint">此職業尚未有專屬規則，技能不區分 GCD／oGCD。</p>}
      <Metrics
        mine={mine}
        reference={reference}
        alignment={alignment}
        abilities={abilities}
        job={job}
        lost={lost}
        onFocus={jumpTo}
      />
      <h3>站位比較</h3>
      <Positions
        track={positions.track}
        divergences={positions.divergences}
        mineSamples={positions.mineSamples}
        refSamples={reference.playerPositions}
        threshold={DIVERGENCE_YALM}
        duration={duration}
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
