import { useEffect, useRef, useState } from 'react'
import type { TimedCast } from '../analysis/alignment'
import { variantCount } from '../analysis/mechanicMatch'
import { formatFightTime } from '../analysis/timeline'
import { fetchTcRankings, type TcRanking } from '../fflogs/client'
import { reportUrl } from '../fflogs/url'
import { jobName } from '../jobs/names'
import { Dropdown, type DropdownOption } from '../ui/Dropdown'
import { loadBossCasts, type Selection } from './load'

// 同時比對機制的請求數（Worker 每 IP 每分鐘 60 次）
const MECHANIC_CONCURRENCY = 3
// 最多列出（並比對機制）的筆數：同一人常有多場，列多一點才找得到機制相同的
const MAX_LISTED = 40

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
    { status: 'idle' } | { status: 'error'; message: string } | { status: 'ready'; count: number; rows: TcRanking[] }
  >({ status: 'idle' })
  // 搜尋中保留上一次的結果（不換成「搜尋中」文字），避免面板高度跳動造成閃爍
  const [loading, setLoading] = useState(false)
  const [mechanics, setMechanics] = useState<Map<string, MechanicState>>(new Map())
  // 已從選單選為參考的紀錄
  const [picked, setPicked] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  // 點面板外或按 Esc 關閉（搜尋結果保留，再打開不用重搜）
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
  const mineBoss = useRef<{ key: string; casts: Promise<TimedCast[]> } | null>(null)

  const mineKey = mine ? `${mine.report.code}/${mine.fight.id}/${mine.player.subType}` : null
  // 換了我的日誌就清掉舊的搜尋結果
  useEffect(() => {
    setResult({ status: 'idle' })
    setMechanics(new Map())
    setPicked(null)
  }, [mineKey])

  const search = async () => {
    if (!mine) return
    setLoading(true)
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
    } finally {
      // 結果換掉時才清掉舊的機制比對與選擇
      setMechanics(new Map())
      setPicked(null)
      setLoading(false)
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

  if (!mine) {
    return (
      <div className="finder">
        <button type="button" className="finder-toggle" disabled title="先選好「我的日誌」的戰鬥與角色">
          從排名找
        </button>
      </div>
    )
  }
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

  // 浮在頁面上的面板，不推擠下方的戰鬥／角色欄位
  return (
    <div className="finder" ref={root}>
      <button
        type="button"
        className={`finder-toggle${open ? ' open' : ''}`}
        aria-expanded={open}
        title="從繁中服排名找參考日誌"
        onClick={() => setOpen((o) => !o)}
      >
        從排名找
      </button>
      {open && (
        <div className="finder-panel" role="dialog" aria-label="從繁中服排名找參考日誌">
          <div className="finder-controls">
            <label title={`PR 只在繁中服的${jobName(mine.player.subType)}之間計算`}>
              {jobName(mine.player.subType)} PR
              <PrInput value={minPr} min={0} max={maxPr} onChange={setMinPr} />
              ～
              <PrInput value={maxPr} min={minPr} max={100} onChange={setMaxPr} />
            </label>
            <label className="finder-check" title="逐筆比對 Boss 的隨機機制，只列出與我的戰鬥相同的紀錄">
              <input type="checkbox" checked={sameMechanics} onChange={(e) => setSameMechanics(e.target.checked)} />
              機制相同
            </label>
            <button type="button" className="finder-search" onClick={search} disabled={loading}>
              {loading ? '搜尋中…' : '搜尋'}
            </button>
          </div>
          <div className={loading ? 'finder-result stale' : 'finder-result'} aria-busy={loading}>
          {result.status === 'error' && <p className="error">{result.message}</p>}
          {result.status === 'ready' &&
            (rows.length === 0 ? (
              <p className="hint">沒有符合的紀錄。</p>
            ) : (
              <Dropdown
                // 摘要只佔一行，完整說明放在滑鼠提示，避免撐高輸入框
                label={
                  <span className="finder-summary">
                    <span
                      title={`繁中服${mine.fight.name}的${jobName(mine.player.subType)}共 ${result.count} 人，每場擊殺各自計算 PR（與其他玩家各自最好的一場比較），列出 PR 在範圍內的所有場次（重複上傳的只留一筆），依 rDPS 排序（# 為所有場次依 rDPS 的名次）的前 ${MAX_LISTED} 筆`}
                    >
                      共 {result.count} 人，列出 {result.rows.length} 筆
                    </span>
                    {noneSame && <span title="沒有隨機機制完全相同的紀錄，改依不同處由少到多排序">・無完全相同，依差異排序</span>}
                  </span>
                }
                placeholder={`選擇要參考的紀錄（${rows.length} 筆）`}
                options={rows.map((r) => rankingOption(r, sameMechanics ? (mechanics.get(rowKey(r)) ?? { status: 'loading' }) : undefined))}
                value={picked}
                onChange={(key) => {
                  const r = rows.find((row) => rowKey(row) === key)
                  if (!r) return
                  setPicked(key)
                  onPick(reportUrl(r.report, r.fight, r.actor))
                  setOpen(false)
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** 排名紀錄的選項：名次、PR、玩家 @ 伺服器、rDPS、戰鬥長度（日期放在滑鼠提示） */
function rankingOption(r: TcRanking, mech: MechanicState | undefined): DropdownOption<string> {
  const date = new Date(r.reportStart).toLocaleDateString('zh-TW')
  return {
    value: rowKey(r),
    title: `${r.name} @ ${r.server}，${Math.round(r.rdps).toLocaleString()} rDPS，${formatFightTime(r.fightEnd - r.fightStart).replace(/\.\d$/, '')}，${date}`,
    content: (
      <span className={`option-row finder-option${mech ? ' with-mech' : ''}`}>
        <span className="finder-rank">#{r.rank}</span>
        <span className="finder-pr">PR {r.pr}</span>
        <span className="option-main">
          {r.name}
          <span className="finder-server"> @ {r.server}</span>
        </span>
        <span className="option-meta">
          {Math.round(r.rdps).toLocaleString()}
          <span className="finder-unit"> rDPS</span>
        </span>
        <span className="option-meta finder-time">{formatFightTime(r.fightEnd - r.fightStart).replace(/\.\d$/, '')}</span>
        {mech && (
          <span className="finder-mech">
            {mech.status === 'loading' ? '比對中…' : mech.status === 'error' ? '—' : mech.variants === 0 ? '機制相同' : `${mech.variants} 處不同`}
          </span>
        )}
      </span>
    ),
  }
}

function rowKey(r: TcRanking): string {
  return `${r.report}/${r.fight}/${r.actor}`
}

/**
 * PR 輸入框，限制在 [min, max]（下限不超過上限）。輸入中的中間值（例如要打 95 時先出現的 9）
 * 先暫存不套用，在範圍內才套用；離開輸入框時把超出範圍的值夾回範圍內。
 */
function PrInput({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const parse = (text: string) => Math.round(Number(text))
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={draft ?? value}
      onChange={(e) => {
        const n = parse(e.target.value)
        if (e.target.value !== '' && Number.isFinite(n) && n >= min && n <= max) {
          onChange(n)
          setDraft(null)
        } else {
          setDraft(e.target.value)
        }
      }}
      onBlur={() => {
        if (draft === null) return
        const n = parse(draft)
        onChange(Number.isFinite(n) && draft !== '' ? Math.min(max, Math.max(min, n)) : value)
        setDraft(null)
      }}
    />
  )
}
