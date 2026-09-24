import { useEffect, useState } from 'react'
import { formatFightTime } from './analysis/timeline'
import { resolveSelection, type Overrides, type Preference } from './compare/autoSelect'
import { fetchReport } from './fflogs/client'
import { Comparison } from './compare/Comparison'
import type { Selection } from './compare/load'
import type { Fight, Report } from './fflogs/types'
import { parseReportUrl, type ReportRef } from './fflogs/url'

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; report: Report }

function useReport(code: string | null): LoadState {
  const [result, setResult] = useState<{ code: string; report?: Report; error?: string } | null>(null)

  useEffect(() => {
    if (!code) return
    const controller = new AbortController()
    fetchReport(code, controller.signal)
      .then((report) => setResult({ code, report }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setResult({ code, error: err instanceof Error ? err.message : String(err) })
      })
    return () => controller.abort()
  }, [code])

  if (!code) return { status: 'idle' }
  if (result?.code !== code) return { status: 'loading' }
  if (result.report) return { status: 'ready', report: result.report }
  return { status: 'error', message: result.error ?? '未知錯誤' }
}

function fightLabel(fight: Fight): string {
  const outcome = fight.kill ? '擊殺' : fight.kill === false ? '滅團' : ''
  return `#${fight.id} ${fight.name} ${outcome} (${formatFightTime(fight.endTime - fight.startTime)})`
}

function ReportSelector({
  report,
  urlRef,
  preferred,
  onChange,
}: {
  report: Report
  urlRef: ReportRef
  preferred?: Preference
  onChange: (selection: Selection | null) => void
}) {
  const [overrides, setOverrides] = useState<Overrides>({ fightId: null, playerId: null })
  const { fight, players, player, note } = resolveSelection(report, urlRef, overrides, preferred)

  useEffect(() => {
    onChange(fight && player ? { report, fight, player } : null)
  }, [report, fight, player, onChange])

  if (report.fights.length === 0) return <p className="error">這份報告沒有戰鬥紀錄</p>

  return (
    <div className="selectors">
      <p className="report-title">{report.title}</p>
      <label>
        戰鬥
        <select
          value={fight?.id ?? ''}
          // 換戰鬥時角色回到自動選擇
          onChange={(e) => setOverrides({ fightId: Number(e.target.value), playerId: null })}
        >
          {report.fights.map((f) => (
            <option key={f.id} value={f.id}>
              {fightLabel(f)}
            </option>
          ))}
        </select>
      </label>
      <label>
        角色
        <select
          value={player?.id ?? ''}
          onChange={(e) => setOverrides((o) => ({ ...o, playerId: Number(e.target.value) }))}
        >
          <option value="" disabled>
            請選擇角色
          </option>
          {players.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（{p.subType}）
            </option>
          ))}
        </select>
      </label>
      {note && !player && <p className="hint">{note}</p>}
    </div>
  )
}

function LogPicker({
  label,
  preferred,
  onChange,
}: {
  label: string
  preferred?: Preference
  onChange: (selection: Selection | null) => void
}) {
  const [url, setUrl] = useState('')
  const ref = url.trim() ? parseReportUrl(url) : null
  const code = useDebounced(ref?.reportCode ?? null, 400)
  const state = useReport(code)

  useEffect(() => {
    if (state.status !== 'ready') onChange(null)
  }, [state.status, onChange])

  return (
    <section className="log-input">
      <label>
        {label}
        <input
          type="url"
          placeholder="https://www.fflogs.com/reports/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      {url.trim() && !ref && <p className="error">無法辨識的 FFLogs 報告連結</p>}
      {state.status === 'loading' && <p>載入報告中…</p>}
      {state.status === 'error' && <p className="error">{state.message}</p>}
      {state.status === 'ready' && ref && (
        // 連結中的 fight / source 改變時重新套用預選
        <ReportSelector
          key={`${state.report.code}|${ref.fight ?? ''}|${ref.sourceId ?? ''}`}
          report={state.report}
          urlRef={ref}
          preferred={preferred}
          onChange={onChange}
        />
      )}
    </section>
  )
}

export default function App() {
  const [mine, setMine] = useState<Selection | null>(null)
  const [reference, setReference] = useState<Selection | null>(null)
  // 參考日誌依我選的 Boss 與職業自動選擇戰鬥與角色
  const preferred = mine ? { encounterID: mine.fight.encounterID, subType: mine.player.subType } : undefined

  return (
    <>
      <h1>FF14 CopyCat</h1>
      <p className="subtitle">比較你與高階玩家的 FFLogs 日誌，找出技能循環與站位的差異。</p>

      <div className="logs">
        <LogPicker label="我的日誌" onChange={setMine} />
        <LogPicker label="參考日誌（高階玩家）" preferred={preferred} onChange={setReference} />
      </div>

      {mine && reference && (
        <section className="comparison">
          <h2>
            {mine.player.name} vs {reference.player.name}（{reference.player.subType}）
          </h2>
          <Comparison mine={mine} reference={reference} />
        </section>
      )}
    </>
  )
}
