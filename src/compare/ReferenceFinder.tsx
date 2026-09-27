import { useEffect, useMemo, useRef, useState } from 'react'
import type { TimedCast } from '../analysis/alignment'
import { mainMechanicGroups, mechanicIds, variantPoints } from '../analysis/mainMechanics'
import { formatFightTime } from '../analysis/timeline'
import { fetchAbilityNames, fetchTcRankings, type TcRanking } from '../fflogs/client'
import { reportUrl } from '../fflogs/url'
import { jobName } from '../jobs/names'
import { Dropdown, type DropdownOption } from '../ui/Dropdown'
import { loadBossCasts, type Selection } from './load'

// 同時比對機制的請求數（Worker 每 IP 每分鐘 60 次）
const MECHANIC_CONCURRENCY = 3
// 最多列出（並比對機制）的筆數：同一人常有多場，列多一點才找得到機制相同的
const MAX_LISTED = 40

// done：各機制（主要機制的鍵）隨機變化不同的次數
type MechanicState = { status: 'loading' } | { status: 'done'; points: { t: number; keys: number[] }[] } | { status: 'error' }

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
          state = {
            status: 'done',
            points: variantPoints(mine.fight.encounterID, await mineCasts, casts, mineDuration, row.fightEnd - row.fightStart),
          }
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

  // 不列入比對的機制（使用者取消勾選的），依 Boss 記住
  const encounter = mine?.fight.encounterID ?? 0
  const [ignored, setIgnored] = useState<{ encounter: number; keys: Set<number> }>({ encounter: 0, keys: new Set() })
  const ignoredKeys = ignored.encounter === encounter ? ignored.keys : loadIgnored(encounter)
  const toggleMechanic = (toggled: number[], checked: boolean) => {
    const keys = new Set(ignoredKeys)
    for (const key of toggled) {
      if (checked) keys.delete(key)
      else keys.add(key)
    }
    setIgnored({ encounter, keys })
    saveIgnored(encounter, keys)
  }

  // 比對結果中出現過不同的機制
  const differing = useMemo(() => {
    const keys = new Set<number>()
    for (const m of mechanics.values()) if (m.status === 'done') for (const p of m.points) for (const key of p.keys) keys.add(key)
    return [...keys].sort((a, b) => a - b)
  }, [mechanics])

  // 機制名稱（繁中服）
  const [names, setNames] = useState<Map<number, string>>(new Map())
  // 有主要機制資料的 Boss 在勾選時就一次查完（比對開始後請求多，可能碰到 Worker 的次數限制）
  const mainIds = mainMechanicGroups(encounter)
  const wantedIds = mainIds ? [...mainIds.keys()] : differing.flatMap((key) => mechanicIds(encounter, key))
  const missingKey = sameMechanics
    ? [...new Set(wantedIds.filter((id) => !names.has(id)))].sort((a, b) => a - b).join(',')
    : ''
  const [nameRetry, setNameRetry] = useState(0)
  useEffect(() => {
    if (!missingKey) return
    const controller = new AbortController()
    const ids = missingKey.split(',').map(Number)
    fetchAbilityNames(ids, controller.signal)
      // 查不到名稱的記為空字串，不再重查
      .then((found) => setNames((n) => new Map([...n, ...ids.map((id) => [id, found.get(id)?.name ?? ''] as const)])))
      .catch(() => {
        // 碰到次數限制等：稍後重試
        if (!controller.signal.aborted) setTimeout(() => setNameRetry((r) => r + 1), 5000)
      })
    return () => controller.abort()
  }, [missingKey, nameRetry])
  const mechanicName = (key: number) => {
    const list = [...new Set(mechanicIds(encounter, key).map((id) => names.get(id)).filter((n) => !!n))]
    if (list.length === 0) return `#${key}`
    return list.length > 3 ? `${list.slice(0, 3).join('／')}…` : list.join('／')
  }
  // 勾選清單：繁中名稱相同的機制（例如圓形與扇形的群狼劍）合併成一項
  const byLabel = new Map<string, number[]>()
  for (const key of differing) byLabel.set(mechanicName(key), [...(byLabel.get(mechanicName(key)) ?? []), key])
  const checklist = [...byLabel].map(([label, keys]) => ({
    label,
    keys,
    records: [...mechanics.values()].filter((m) => m.status === 'done' && m.points.some((p) => p.keys.some((k) => keys.includes(k)))).length,
  }))

  if (!mine) {
    return (
      <div className="finder">
        <button type="button" className="finder-toggle" disabled title="先選好「我的日誌」的戰鬥與角色">
          <SearchIcon />
          搜尋前輩日誌
        </button>
      </div>
    )
  }
  // 與我不同的時間點（同一時間多個機制不同算一處），只數涉及勾選機制的；每處為「時間 機制名稱」
  const differencesOf = (r: TcRanking) => {
    const m = mechanics.get(rowKey(r))
    if (m?.status !== 'done') return undefined
    return m.points.flatMap((p) => {
      const names = [...new Set(p.keys.filter((k) => !ignoredKeys.has(k)).map(mechanicName))]
      return names.length === 0 ? [] : [`${formatFightTime(p.t).replace(/\.\d$/, '')} ${names.join('、')}`]
    })
  }
  const variantsOf = (r: TcRanking) => differencesOf(r)?.length
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
  // 處理中（搜尋、或勾選機制相同後逐筆比對）：只顯示轉圈，完成後才顯示結果並允許操作，避免筆數跟著比對進度跳動
  const comparing = sameMechanics && result.status === 'ready' && !compared
  const busy = loading || comparing

  // 浮在頁面上的面板，不推擠下方的戰鬥／角色欄位
  return (
    <div className="finder" ref={root}>
      <button
        type="button"
        className={`finder-toggle${open ? ' open' : ''}`}
        aria-expanded={open}
        title="依 PR 從繁中服排名中找同 Boss、同職業的前輩日誌"
        onClick={() => setOpen((o) => !o)}
      >
        <SearchIcon />
        搜尋前輩日誌
      </button>
      {open && (
        <div className="finder-panel" role="dialog" aria-label="從繁中服排名找參考日誌">
          <div className="finder-controls">
            <label title={`PR 只在繁中服的${jobName(mine.player.subType)}之間計算`}>
              {jobName(mine.player.subType)} PR
              <PrInput value={minPr} min={0} max={maxPr} disabled={busy} onChange={setMinPr} />
              ～
              <PrInput value={maxPr} min={minPr} max={100} disabled={busy} onChange={setMaxPr} />
            </label>
            <label className="finder-check" title="逐筆比對 Boss 的隨機機制，只列出與我的戰鬥相同的紀錄">
              <input
                type="checkbox"
                checked={sameMechanics}
                disabled={busy}
                onChange={(e) => setSameMechanics(e.target.checked)}
              />
              機制相同
            </label>
            <button type="button" className="finder-search" onClick={search} disabled={busy}>
              搜尋
            </button>
          </div>
          {sameMechanics && !busy && checklist.length > 0 && (
            <details className="finder-mechanics">
              <summary title="只比對勾選的機制；取消勾選不在意的機制（依 Boss 記住）">
                比對的機制（{checklist.filter((c) => !c.keys.every((k) => ignoredKeys.has(k))).length}／{checklist.length}）
              </summary>
              <div className="finder-mechanic-list">
                {checklist.map((c) => (
                  <label key={c.label} className="finder-check" title={`${c.records} 筆紀錄與我不同`}>
                    <input
                      type="checkbox"
                      checked={!c.keys.every((k) => ignoredKeys.has(k))}
                      onChange={(e) => toggleMechanic(c.keys, e.target.checked)}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            </details>
          )}
          <div className={busy || result.status === 'ready' ? 'finder-result filled' : 'finder-result'} aria-busy={busy}>
          {busy && (
            <p className="finder-busy" role="status">
              <span className="spinner" aria-hidden="true" />
              {loading ? '搜尋中…' : '比對機制中…'}
            </p>
          )}
          {!busy && result.status === 'error' && <p className="error">{result.message}</p>}
          {!busy &&
            result.status === 'ready' &&
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
                options={rows.map((r) =>
                  rankingOption(
                    r,
                    sameMechanics ? (mechanics.get(rowKey(r)) ?? { status: 'loading' }) : undefined,
                    differencesOf(r) ?? [],
                  ),
                )}
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

/** 放大鏡圖示（大小跟著文字） */
function SearchIcon() {
  return (
    <svg className="finder-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/** 排名紀錄的選項：名次、PR、玩家 @ 伺服器、rDPS、戰鬥長度（日期放在滑鼠提示） */
function rankingOption(r: TcRanking, mech: MechanicState | undefined, differences: string[]): DropdownOption<string> {
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
          <span className="finder-mech" title={differences.length > 0 ? `不同的時間點（這筆紀錄的戰鬥時間）：\n${differences.join('\n')}` : undefined}>
            {mech.status === 'loading'
              ? '比對中…'
              : mech.status === 'error'
                ? '—'
                : differences.length === 0
                  ? '機制相同'
                  : `${differences.length} 處不同`}
          </span>
        )}
      </span>
    ),
  }
}

const IGNORED_KEY = 'finder-ignored-mechanics:'

function loadIgnored(encounter: number): Set<number> {
  try {
    const raw = localStorage.getItem(IGNORED_KEY + encounter)
    return new Set(raw ? (JSON.parse(raw) as number[]) : [])
  } catch {
    return new Set()
  }
}

function saveIgnored(encounter: number, keys: Set<number>) {
  try {
    localStorage.setItem(IGNORED_KEY + encounter, JSON.stringify([...keys]))
  } catch {
    // 無法儲存（私密瀏覽等）時只在這次有效
  }
}

function rowKey(r: TcRanking): string {
  return `${r.report}/${r.fight}/${r.actor}`
}

/**
 * PR 輸入框，限制在 [min, max]（下限不超過上限）。輸入中的中間值（例如要打 95 時先出現的 9）
 * 先暫存不套用，在範圍內才套用；離開輸入框時把超出範圍的值夾回範圍內。
 */
function PrInput({
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  value: number
  min: number
  max: number
  disabled?: boolean
  onChange: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const parse = (text: string) => Math.round(Number(text))
  return (
    <input
      type="number"
      disabled={disabled}
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
