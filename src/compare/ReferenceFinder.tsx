import { useEffect, useRef, useState } from 'react'
import type { TimedCast } from '../analysis/alignment'
import { variantCount } from '../analysis/mechanicMatch'
import { formatFightTime } from '../analysis/timeline'
import { fetchTcRankings, type TcRanking } from '../fflogs/client'
import { reportUrl } from '../fflogs/url'
import { jobName } from '../jobs/names'
import { loadBossCasts, type Selection } from './load'

// 同時比對機制的請求數（Worker 每 IP 每分鐘 60 次）
const MECHANIC_CONCURRENCY = 3
// 最多列出（並比對機制）的筆數
const MAX_LISTED = 20

type MechanicState = { status: 'loading' } | { status: 'done'; variants: number } | { status: 'error' }

/**
 * 從繁中服排名找參考日誌：依 PR 範圍列出同 Boss、同職業的紀錄（由高到低），
 * 可只顯示隨機機制與我相同的。點選後填入參考日誌。
 */
export function ReferenceFinder({ mine, onPick }: { mine: Selection | null; onPick: (url: string) => void }) {
  const [minPr, setMinPr] = useState(90)
  const [maxPr, setMaxPr] = useState(100)
  const [sameMechanics, setSameMechanics] = useState(false)
  const [result, setResult] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; count: number; rows: TcRanking[] }
  >({ status: 'idle' })
  const [mechanics, setMechanics] = useState<Map<string, MechanicState>>(new Map())
  const mineBoss = useRef<{ key: string; casts: Promise<TimedCast[]> } | null>(null)

  const mineKey = mine ? `${mine.report.code}/${mine.fight.id}/${mine.player.subType}` : null
  // 換了我的日誌就清掉舊的搜尋結果
  useEffect(() => {
    setResult({ status: 'idle' })
    setMechanics(new Map())
  }, [mineKey])

  const search = async () => {
    if (!mine) return
    setResult({ status: 'loading' })
    setMechanics(new Map())
    try {
      const { count, rankings } = await fetchTcRankings({
        encounter: mine.fight.encounterID,
        difficulty: mine.fight.difficulty ?? 0,
        job: mine.player.subType,
        minPr,
        maxPr,
      })
      setResult({ status: 'ready', count, rows: rankings.slice(0, MAX_LISTED) })
    } catch (err) {
      setResult({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  // 勾選「只顯示隨機機制相同」時，逐筆抓 Boss 施放與我的比對（結果保留，取消勾選再勾不重抓）
  useEffect(() => {
    if (!sameMechanics || result.status !== 'ready' || !mine) return
    const controller = new AbortController()
    const key = `${mine.report.code}/${mine.fight.id}`
    if (mineBoss.current?.key !== key) {
      mineBoss.current = { key, casts: loadBossCasts(mine.report.code, mine.fight) }
    }
    const mineCasts = mineBoss.current.casts
    const mineDuration = mine.fight.endTime - mine.fight.startTime
    const pending = result.rows.filter((r) => !mechanics.has(rowKey(r)))
    if (pending.length === 0) return
    setMechanics((m) => new Map([...m, ...pending.map((r) => [rowKey(r), { status: 'loading' } as MechanicState] as const)]))
    const queue = [...pending]
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        let state: MechanicState
        try {
          const casts = await loadBossCasts(row.report, { id: row.fight, startTime: row.fightStart, endTime: row.fightEnd }, controller.signal)
          state = { status: 'done', variants: variantCount(await mineCasts, casts, mineDuration, row.fightEnd - row.fightStart) }
        } catch {
          if (controller.signal.aborted) return
          state = { status: 'error' }
        }
        const k = rowKey(row)
        setMechanics((m) => new Map(m).set(k, state))
      }
    }
    void Promise.all(Array.from({ length: MECHANIC_CONCURRENCY }, worker))
    return () => controller.abort()
    // mechanics 只用來跳過已比對的，不需要因它重跑
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [sameMechanics, result, mine])

  if (!mine) return null
  const variantsOf = (r: TcRanking) => {
    const m = mechanics.get(rowKey(r))
    return m?.status === 'done' ? m.variants : undefined
  }
  const all = result.status === 'ready' ? result.rows : []
  const compared = all.every((r) => variantsOf(r) !== undefined || mechanics.get(rowKey(r))?.status === 'error')
  const same = all.filter((r) => variantsOf(r) === undefined || variantsOf(r) === 0)
  // 隨機機制多的 Boss 很難有完全相同的：比對完仍沒有時，改依差異由少到多列出
  const noneSame = sameMechanics && compared && all.length > 0 && same.every((r) => variantsOf(r) === undefined)
  const rows = !sameMechanics
    ? all
    : noneSame
      ? [...all].sort((a, b) => (variantsOf(a) ?? Infinity) - (variantsOf(b) ?? Infinity))
      : same

  return (
    <details className="finder">
      <summary>從繁中服排名找參考日誌</summary>
      <div className="finder-controls">
        <label>
          PR
          <input type="number" min={0} max={100} value={minPr} onChange={(e) => setMinPr(clampPr(e.target.value))} />
          ～
          <input type="number" min={0} max={100} value={maxPr} onChange={(e) => setMaxPr(clampPr(e.target.value))} />
        </label>
        <label className="finder-check">
          <input type="checkbox" checked={sameMechanics} onChange={(e) => setSameMechanics(e.target.checked)} />
          只顯示隨機機制相同的
        </label>
        <button type="button" onClick={search} disabled={result.status === 'loading' || minPr > maxPr}>
          搜尋
        </button>
      </div>
      {result.status === 'loading' && <p className="hint">搜尋中…</p>}
      {result.status === 'error' && <p className="error">{result.message}</p>}
      {result.status === 'ready' && (
        <>
          <p className="hint">
            繁中服{mine.fight.name}的{jobName(mine.player.subType)}共 {result.count} 人（每人取最好的一場，依 DPS 排序）；
            PR {minPr}～{maxPr} 列出前 {result.rows.length} 筆。
          </p>
          {noneSame && <p className="hint">沒有隨機機制完全相同的紀錄，以下依不同處由少到多列出。</p>}
          {rows.length === 0 ? (
            <p className="hint">沒有符合的紀錄。</p>
          ) : (
            <ul className="finder-list">
              {rows.map((r) => {
                const m = mechanics.get(rowKey(r))
                return (
                  <li key={rowKey(r)}>
                    <button
                      type="button"
                      onClick={() => onPick(reportUrl(r.report, r.fight, r.actor))}
                      title="選為參考日誌"
                    >
                      <span className="finder-rank">#{r.rank}</span>
                      <span className="finder-pr">PR {r.pr}</span>
                      <span className="finder-name">
                        {r.name}
                        <span className="hint-inline">（{r.server}）</span>
                      </span>
                      <span className="finder-meta">{Math.round(r.dps).toLocaleString()} DPS</span>
                      <span className="finder-meta">{formatFightTime(r.fightEnd - r.fightStart).replace(/\.\d$/, '')}</span>
                      <span className="finder-meta">{new Date(r.reportStart).toLocaleDateString('zh-TW')}</span>
                      {sameMechanics && (
                        <span className="finder-mech">
                          {!m || m.status === 'loading' ? '比對中…' : m.status === 'error' ? '—' : m.variants === 0 ? '機制相同' : `${m.variants} 處不同`}
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </details>
  )
}

function rowKey(r: TcRanking): string {
  return `${r.report}/${r.fight}/${r.actor}`
}

function clampPr(value: string): number {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0
}
