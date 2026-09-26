import { useEffect, useMemo, useState } from 'react'
import { formatFightTime } from './analysis/timeline'
import { resolveSelection, type Overrides, type Preference } from './compare/autoSelect'
import { fetchAutoAttacksTaken, fetchFightNames, fetchReport, translateReport } from './fflogs/client'
import { playersInFight } from './fflogs/report'
import { isStandardParty, jobName, jobRole, sortByPartySlot } from './jobs/names'
import { Comparison } from './compare/Comparison'
import type { Selection } from './compare/load'
import type { Actor, Fight, Report } from './fflogs/types'
import { parseReportUrl, type ReportRef } from './fflogs/url'
import { Dropdown, type DropdownOption } from './ui/Dropdown'

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

  // Boss 繁中名稱另外查詢，查到前先顯示英文，不阻擋選擇與比較
  const [npcNames, setNpcNames] = useState<{ code: string; names: Map<string, string> } | null>(null)
  const loaded = result?.code === code ? result.report : undefined
  useEffect(() => {
    if (!loaded || !code) return
    const controller = new AbortController()
    fetchFightNames(loaded, controller.signal)
      .then((names) => setNpcNames({ code, names }))
      .catch(() => {}) // 查不到就沿用英文
    return () => controller.abort()
  }, [loaded, code])
  const report = useMemo(
    () => (loaded && npcNames?.code === code ? translateReport(loaded, npcNames.names) : loaded),
    [loaded, npcNames, code],
  )

  if (!code) return { status: 'idle' }
  if (result?.code !== code) return { status: 'loading' }
  if (report) return { status: 'ready', report }
  return { status: 'error', message: result.error ?? '未知錯誤' }
}

function fightOption(fight: Fight): DropdownOption<number> {
  const outcome = fight.kill ? '擊殺' : fight.kill === false ? '滅團' : null
  return {
    value: fight.id,
    title: fight.englishName,
    content: (
      // 固定欄寬，讓每列的徽章與長度對齊
      <span className="option-row fight-option">
        <span className="option-id">#{fight.id}</span>
        <span className="option-main">{fight.name}</span>
        <span className="option-meta">{formatFightTime(fight.endTime - fight.startTime)}</span>
        <span className="option-badge">
          {outcome && <span className={`badge ${fight.kill ? 'kill' : 'wipe'}`}>{outcome}</span>}
        </span>
      </span>
    ),
  }
}

function playerOption(player: Actor, slot: string | null): DropdownOption<number> {
  return {
    value: player.id,
    content: (
      <span className="option-row">
        {slot && <span className="option-slot">{slot}</span>}
        <span className="option-main">{player.name}</span>
        <span className={`badge job ${jobRole(player.subType)}`}>{jobName(player.subType)}</span>
      </span>
    ),
  }
}

/**
 * 標準隊伍（2 坦）時查詢每位玩家承受的 Boss 普通攻擊傷害，用來判斷 MT／ST。
 * 查詢中或失敗時回傳 undefined（坦克不標位置）。
 */
function useTankLoad(code: string, fight: Fight | undefined, players: Actor[]): Map<number, number> | undefined {
  const [result, setResult] = useState<{ key: string; load: Map<number, number> } | null>(null)
  const key = fight && isStandardParty(players) ? `${code}/${fight.id}` : null
  useEffect(() => {
    if (!key || !fight) return
    const controller = new AbortController()
    fetchAutoAttacksTaken(code, fight.id, controller.signal)
      .then((load) => setResult({ key, load }))
      .catch(() => {}) // 查不到就不標 MT／ST
    return () => controller.abort()
  }, [key, code, fight])
  return result && result.key === key ? result.load : undefined
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
  const { fights, fight, fightNote, players, player, note, locked } = resolveSelection(report, urlRef, overrides, preferred)
  // 依隊伍位置排序；位置以整場隊伍判斷（參考日誌的選單只列同職業，但位置仍依全隊）
  const everyone = fight ? playersInFight(report, fight) : []
  const tankLoad = useTankLoad(report.code, fight, everyone)
  const party = sortByPartySlot(everyone, tankLoad)
  const listed = new Set(players.map((p) => p.id))
  const playerOptions = party.filter(({ player: p }) => listed.has(p.id)).map(({ player: p, slot }) => playerOption(p, slot))
  // 參考日誌沒有同職業的玩家：選單直接顯示原因並停用，不另外加說明列
  const noMatch = players.length === 0 && note !== null

  useEffect(() => {
    onChange(fight && player ? { report, fight, player } : null)
  }, [report, fight, player, onChange])

  if (report.fights.length === 0) return <p className="error">這份報告沒有戰鬥紀錄</p>

  return (
    <div className="selectors">
      <Dropdown
        label="戰鬥"
        // 參考日誌只列與我同一個 Boss 的戰鬥；沒有時選單顯示原因並停用（與沒有同職業時相同）
        options={fights.map(fightOption)}
        value={fight?.id ?? null}
        placeholder={fightNote ?? '請選擇戰鬥'}
        disabled={fightNote !== null}
        disabledTitle={fightNote ?? undefined}
        lockLabel={null}
        // 換戰鬥時角色回到自動選擇
        onChange={(fightId) => setOverrides({ fightId, playerId: null })}
      />
      <Dropdown
        label="角色"
        options={playerOptions}
        value={player?.id ?? null}
        // 需要使用者注意的說明（沒有同職業、有多位同職業）直接顯示在選單上，避免多一列
        placeholder={note ?? '請選擇角色'}
        disabled={locked || noMatch}
        disabledTitle={noMatch ? (note ?? undefined) : '這場戰鬥只有這位與你同職業的玩家'}
        lockLabel={noMatch ? null : '已鎖定'}
        onChange={(playerId) => setOverrides((o) => ({ ...o, playerId }))}
      />
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
  const preferred = mine
    ? { encounterID: mine.fight.encounterID, bossName: mine.fight.name, subType: mine.player.subType }
    : undefined

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
          <h2>比較結果</h2>
          <Comparison mine={mine} reference={reference} />
        </section>
      )}
    </>
  )
}
