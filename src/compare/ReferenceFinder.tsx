import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { TimedCast } from '../analysis/alignment'
import {
  mainMechanicGroups,
  mechanicIds,
  mechanicOccurrences,
  occurrenceOf,
  variantPoints,
  type MechanicOccurrence,
} from '../analysis/mainMechanics'
import { formatFightTime } from '../analysis/timeline'
import { DB_UNAVAILABLE_MESSAGE, dbStatus, fetchAbilityNames, fetchPullTimelines, fetchTcRankings, type TcRanking } from '../fflogs/client'
import { decodeCasts } from '../analysis/castCodec'
import { reportUrl } from '../fflogs/url'
import { jobName } from '../jobs/names'
import { Dropdown, type DropdownOption } from '../ui/Dropdown'
import { JobBadge } from '../ui/JobBadge'
import { useIgnoredOccurrences } from './focusedMechanics'
import { loadBossCasts, type Selection } from './load'
import { defaultPrRange, useSideDamage } from './sideDamage'
import { HelpTip } from './HelpTip'

// 同時比對機制的請求數（Worker 每 IP 每分鐘 60 次）
const MECHANIC_CONCURRENCY = 3
// 最多列出（並比對機制）的筆數：同一人常有多場，列多一點才找得到機制相同的
const MAX_LISTED = 40

// done：與我隨機機制不同的時間點（t 為該筆紀錄的時間、mineT 為我的時間）與涉及的機制（主要機制的鍵）
type MechanicState =
  | { status: 'loading' }
  | { status: 'done'; points: { t: number; mineT: number; keys: number[] }[] }
  | { status: 'error' }

/**
 * 從繁中服排名找參考日誌：依 PR 範圍列出同 Boss、同職業的紀錄（由高到低），
 * 可只顯示隨機機制與我相同的。點選後填入參考日誌。
 */
export function ReferenceFinder({ mine, onPick }: { mine: Selection | null; onPick: (url: string) => void }) {
  // PR 範圍預設比我的 PR 高一段（defaultPrRange）；使用者改過就沿用，換了我的日誌再回到預設
  const myPr = useSideDamage(mine)?.pr?.pr ?? null
  const mineKey = mine ? `${mine.report.code}/${mine.fight.id}/${mine.player.id}` : null
  const [edited, setEdited] = useState<{ key: string | null; min: number; max: number } | null>(null)
  const range = edited?.key === mineKey ? edited : defaultPrRange(myPr)
  const minPr = range.min
  const maxPr = range.max
  const setMinPr = (min: number) => setEdited({ key: mineKey, min, max: maxPr })
  const setMaxPr = (max: number) => setEdited({ key: mineKey, min: minPr, max })
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
  // 排名資料庫無法使用（每日讀取額度用完）時停用搜尋，只能貼參考日誌的網址
  const dbAvailable = useSyncExternalStore(dbStatus.subscribe, dbStatus.available)

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
      // 不列自己（名字 @ 伺服器相同）的其他擊殺：要找的是前輩；比較自己的兩場可直接貼連結
      const others = rankings.filter((r) => !(r.name === mine.player.name && r.server === mine.player.server))
      setResult({ status: 'ready', count, rows: others.slice(0, MAX_LISTED) })
    } catch (err) {
      setResult({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      // 結果換掉時才清掉舊的機制比對與選擇
      setMechanics(new Map())
      setPicked(null)
      setLoading(false)
    }
  }

  // 我的 Boss 施放：打開面板就載入（算出我這場的隨機機制時間點，搜尋前就能先勾選要關注的）
  const bossCastsOf = (s: Selection) => {
    const key = `${s.report.code}/${s.fight.id}`
    if (mineBoss.current?.key !== key) mineBoss.current = { key, casts: loadBossCasts(s.report.code, s.fight) }
    return mineBoss.current.casts
  }
  const encounter = mine?.fight.encounterID ?? 0
  const [occurrences, setOccurrences] = useState<{ key: string; list: MechanicOccurrence[] } | null>(null)
  const fightKey = mine ? `${mine.report.code}/${mine.fight.id}` : null
  useEffect(() => {
    if (!open || !mine || occurrences?.key === fightKey) return
    let active = true
    bossCastsOf(mine)
      .then((casts) => active && setOccurrences({ key: fightKey!, list: mechanicOccurrences(mine.fight.encounterID, casts) }))
      .catch(() => active && setOccurrences({ key: fightKey!, list: [] }))
    return () => {
      active = false
    }
    // mine 會隨名稱翻譯換物件；以戰鬥的鍵決定是否重算
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fightKey])
  const myOccurrences = occurrences?.key === fightKey ? occurrences.list : null

  // 勾選「只顯示隨機機制相同」時，逐筆抓 Boss 施放與我的比對（結果保留，取消勾選再勾不重抓）
  useEffect(() => {
    if (!sameMechanics || result.status !== 'ready' || !mine) return
    const controller = new AbortController()
    const mineCasts = bossCastsOf(mine)
    const mineDuration = mine.fight.endTime - mine.fight.startTime
    const pending = result.rows.filter((r) => !mechanics.has(rowKey(r)))
    if (pending.length === 0) return
    setMechanics((m) => new Map([...m, ...pending.map((r) => [rowKey(r), { status: 'loading' } as MechanicState] as const)]))
    // 先一次取回 Worker 已預處理的 Boss 施放（一個請求），沒有預處理到的才逐筆向 FFLogs 抓
    const stored = fetchPullTimelines(pending, controller.signal).catch(() => ({}) as Record<string, string>)
    const queue = [...pending]
    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        let state: MechanicState
        try {
          const encoded = (await stored)[`${row.report}:${row.fight}`]
          const casts =
            encoded !== undefined
              ? decodeCasts(encoded)
              : await loadBossCasts(row.report, { id: row.fight, startTime: row.fightStart, endTime: row.fightEnd }, controller.signal)
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
    return () => {
      controller.abort()
      // 中止時還沒比對完的清掉「比對中」，下次重新比對（否則會被當成已處理而永遠停在比對中）
      const keys = new Set(pending.map(rowKey))
      setMechanics((m) => new Map([...m].filter(([k, s]) => !(keys.has(k) && s.status === 'loading'))))
    }
    // mechanics 只用來跳過已比對的，不需要因它重跑；mine 會隨 Boss 名稱翻譯換物件（資料相同），以戰鬥的鍵決定是否重跑
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [sameMechanics, result, fightKey])

  // 不關注（取消勾選）的時間點，依 Boss 記住；比較結果依此高光（focusedMechanics.ts）
  const [ignored, setIgnored] = useIgnoredOccurrences(encounter)
  const toggleOccurrences = (ids: string[], checked: boolean) => {
    const next = new Set(ignored)
    for (const id of ids) {
      if (checked) next.delete(id)
      else next.add(id)
    }
    setIgnored(next)
  }

  // 比對結果中出現過不同的機制（沒有 cactbot 資料的 Boss 用來查名稱）
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
  const versionName = (ids: number[]) => [...new Set(ids.map((id) => names.get(id)).filter((n) => !!n))].join('／')
  // 每筆比對完的紀錄與我不同的時間點（我這場的時間點 id）
  const differingOccurrences = (m: MechanicState | undefined): Set<string> => {
    const ids = new Set<string>()
    if (m?.status !== 'done' || !myOccurrences) return ids
    for (const p of m.points) {
      for (const key of p.keys) {
        const id = occurrenceOf(myOccurrences, key, p.mineT)
        if (id) ids.add(id)
      }
    }
    return ids
  }
  const differingByRow = new Map([...mechanics].map(([k, m]) => [k, differingOccurrences(m)] as const))
  // 關注清單：我這場的隨機機制時間點，依繁中名稱分組（同名的圓形與扇形群狼劍合併），組內依時間
  const checklist = (() => {
    const byLabel = new Map<string, MechanicOccurrence[]>()
    for (const o of myOccurrences ?? []) byLabel.set(mechanicName(o.key), [...(byLabel.get(mechanicName(o.key)) ?? []), o])
    return [...byLabel].map(([label, list]) => ({
      label,
      occurrences: list
        .sort((a, b) => a.t - b.t)
        .map((o, i) => ({
          ...o,
          // 同名合併後重新編號（第 N 次指這個名稱的第 N 次）
          label: `${i + 1}・${formatFightTime(o.t).replace(/\.\d$/, '')}`,
          version: versionName(o.ids),
          records: [...differingByRow.values()].filter((ids) => ids.has(o.id)).length,
        })),
    }))
  })()
  const totalOccurrences = checklist.reduce((sum, g) => sum + g.occurrences.length, 0)
  const focusedCount = checklist.reduce((sum, g) => sum + g.occurrences.filter((o) => !ignored.has(o.id)).length, 0)

  if (!mine || !dbAvailable) {
    return (
      <div className={`finder${dbAvailable ? '' : ' unavailable'}`}>
        {/* 說明放在按鈕左側，與按鈕垂直置中 */}
        {!dbAvailable && <HelpTip text={`${DB_UNAVAILABLE_MESSAGE}。額度每天台灣時間早上 8 點（UTC 0 點）重置。`} />}
        <button type="button" className="finder-toggle" disabled title={dbAvailable ? '先選好「我的日誌」的戰鬥與角色' : undefined}>
          <SearchIcon />
          搜尋前輩日誌
        </button>
      </div>
    )
  }
  // 與我不同的時間點（同一時間多個機制不同算一處），只算關注的時間點（對不到我這場時間點的也不算：不是使用者選的）；
  // 沒有時間點清單（沒有 cactbot 資料的 Boss）時全部都算。每處為「時間 機制名稱」
  const hasChecklist = !!myOccurrences && myOccurrences.length > 0
  const differencesOf = (r: TcRanking) => {
    const m = mechanics.get(rowKey(r))
    if (m?.status !== 'done') return undefined
    return m.points.flatMap((p) => {
      const focused = p.keys.filter((k) => {
        if (!hasChecklist) return true
        const id = occurrenceOf(myOccurrences!, k, p.mineT)
        return id !== null && !ignored.has(id)
      })
      const names = [...new Set(focused.map(mechanicName))]
      return names.length === 0 ? [] : [`${formatFightTime(p.t).replace(/\.\d$/, '')} ${names.join('、')}`]
    })
  }
  const variantsOf = (r: TcRanking) => differencesOf(r)?.length
  const all = result.status === 'ready' ? result.rows : []
  const compared = all.every((r) => variantsOf(r) !== undefined || mechanics.get(rowKey(r))?.status === 'error')
  // 比對機制時列出全部，依不同處由少到多排序（機制相同的在最前面；同樣多時維持 rDPS 順序），不隱藏不同的
  const exact = all.filter((r) => variantsOf(r) === 0).length
  const rows = sameMechanics ? [...all].sort((a, b) => (variantsOf(a) ?? Infinity) - (variantsOf(b) ?? Infinity)) : all
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
          {/* 第一行：職業徽章＋PR 範圍（靠左）、搜尋（靠右） */}
          <div className="finder-controls">
            <span className="finder-range">
              <JobBadge subType={mine.player.subType} />
              <span>PR</span>
              <PrInput value={minPr} min={0} max={maxPr} disabled={busy} onChange={setMinPr} />
              ～
              <PrInput value={maxPr} min={minPr} max={100} disabled={busy} onChange={setMaxPr} />
              <HelpTip
                text={`PR 只在繁中服的${jobName(mine.player.subType)}之間計算。${
                  myPr === null
                    ? '預設 90～100（你的這場沒有繁中服 PR：未擊殺或沒有排名資料）。'
                    : `預設為比你這場的 PR（${myPr}）高一段：${defaultPrRange(myPr).min}～${defaultPrRange(myPr).max}（高 1～20，上限 100），找輸出與打法比你好一些、較好模仿的前輩。`
                }`}
              />
            </span>
            <button type="button" className="finder-search" onClick={search} disabled={busy}>
              搜尋
            </button>
          </div>
          {/* 第二行：機制相同的排前面＋關注的時間點數 */}
          <div className="finder-same">
            <label className="finder-check">
              <input type="checkbox" checked={sameMechanics} disabled={busy} onChange={(e) => setSameMechanics(e.target.checked)} />
              機制相同的排前面
            </label>
            <HelpTip
              text={[
                '逐筆比對 Boss 的隨機機制，依與我的戰鬥不同處由少到多排序（機制相同的在最前面，其他紀錄照常列出）；每筆標示「機制相同」或「N 處不同」。',
                '下方為你這場中每一次會隨機的機制（cactbot 時間軸中有多個版本的機制），時間與版本取自你這場的 Boss 施放；只比對勾選的時間點，比較結果也會標出這些時間點。依 Boss 記住。',
              ].join('\n')}
            />
            {sameMechanics && totalOccurrences > 0 && (
              <span className="finder-focus-count">
                關注 {focusedCount}／{totalOccurrences} 個時間點
              </span>
            )}
          </div>
          {sameMechanics && myOccurrences === null && <p className="hint">讀取你這場的 Boss 機制…</p>}
          {sameMechanics && checklist.length > 0 && (
            <div className="finder-occurrences">
              {checklist.map((g) => {
                const ids = g.occurrences.map((o) => o.id)
                const on = ids.filter((id) => !ignored.has(id)).length
                return (
                  <div key={g.label} className="finder-occurrence-group">
                    <label className="finder-check">
                      <input
                        type="checkbox"
                        checked={on === ids.length}
                        ref={(el) => {
                          if (el) el.indeterminate = on > 0 && on < ids.length
                        }}
                        onChange={(e) => toggleOccurrences(ids, e.target.checked)}
                      />
                      {g.label}
                    </label>
                    <div className="finder-occurrence-list">
                      {g.occurrences.map((o) => (
                        <label key={o.id} className={`finder-occurrence${ignored.has(o.id) ? '' : ' on'}`}>
                          <input type="checkbox" checked={!ignored.has(o.id)} onChange={(e) => toggleOccurrences([o.id], e.target.checked)} />
                          {o.label}
                          {o.version && o.version !== g.label && <span>{o.version}</span>}
                          {o.records > 0 && <small>{o.records} 筆不同</small>}
                        </label>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
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
                    {sameMechanics && <span>・機制相同 {exact} 筆</span>}
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
