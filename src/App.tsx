import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { formatFightTime } from './analysis/timeline'
import { resolveSelection, type Overrides, type Preference } from './compare/autoSelect'
import { fetchAutoAttacksTaken, fetchFightNames, fetchReport, translateReport } from './fflogs/client'
import { playersInFight } from './fflogs/report'
import { isStandardParty, jobName, jobRole, sortByPartySlot } from './jobs/names'
import { Comparison } from './compare/Comparison'
import { ReferenceFinder } from './compare/ReferenceFinder'
import type { Selection } from './compare/load'
import type { Actor, Fight, Report } from './fflogs/types'
import { parseReportUrl, reportUrl, type ReportRef } from './fflogs/url'
import { readLogParam, writeLogParam, type LogKey } from './pageQuery'
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
      // 沒有位置時也留空欄，讓名稱與戰鬥選單的 Boss 名稱對齊
      <span className="option-row player-option">
        <span className="option-slot">{slot}</span>
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
        showLock={false}
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
        showLock={!noMatch}
        onChange={(playerId) => setOverrides((o) => ({ ...o, playerId }))}
      />
    </div>
  )
}

function LogPicker({
  label,
  storageKey,
  preferred,
  onChange,
  picked,
  action,
}: {
  label: string
  /** 保存在本頁網址的參數名稱 */
  storageKey: LogKey
  preferred?: Preference
  onChange: (selection: Selection | null) => void
  /** 從外部選定的連結（例如從排名找參考）；每次傳入新物件就套用一次 */
  picked?: { url: string } | null
  /** 顯示在標題列右側（例如找參考日誌）；不佔額外高度，兩邊的戰鬥／角色欄位才能對齊 */
  action?: ReactNode
}) {
  const inputId = useId()
  // 重新整理後從本頁網址還原輸入的連結
  const [url, setUrl] = useState(() => readLogParam(storageKey))
  const applyUrl = (next: string) => {
    setUrl(next)
    writeLogParam(storageKey, next)
  }
  // 從外部選定連結時套用一次（網址參數由選定的一方寫入）
  const [lastPicked, setLastPicked] = useState(picked)
  if (picked !== lastPicked) {
    setLastPicked(picked)
    if (picked) setUrl(picked.url)
  }
  const ref = url.trim() ? parseReportUrl(url) : null
  const code = useDebounced(ref?.reportCode ?? null, 400)
  const state = useReport(code)

  useEffect(() => {
    if (state.status !== 'ready') onChange(null)
  }, [state.status, onChange])

  // 選好戰鬥與角色後，網址保存的連結換成帶有這場戰鬥與角色的連結，還原時不用重選
  const onSelect = useCallback(
    (selection: Selection | null) => {
      if (selection) {
        writeLogParam(storageKey, reportUrl(selection.report.code, selection.fight.id, selection.player.id))
      }
      onChange(selection)
    },
    [storageKey, onChange],
  )

  return (
    <section className="log-input">
      <div className="log-head">
        <label htmlFor={inputId}>{label}</label>
        {action}
      </div>
      <input
        id={inputId}
        type="url"
        placeholder="https://www.fflogs.com/reports/..."
        value={url}
        onChange={(e) => applyUrl(e.target.value)}
      />
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
          onChange={onSelect}
        />
      )}
    </section>
  )
}

export default function App() {
  const [mine, setMine] = useState<Selection | null>(null)
  const [reference, setReference] = useState<Selection | null>(null)
  // 從繁中服排名選的參考日誌連結
  const [picked, setPicked] = useState<{ url: string } | null>(null)
  // 參考日誌依我選的 Boss 與職業自動選擇戰鬥與角色
  const preferred = mine
    ? { encounterID: mine.fight.encounterID, bossName: mine.fight.name, subType: mine.player.subType }
    : undefined

  return (
    <>
      <h1>FF14 CopyCat</h1>
      <p className="subtitle">比較你與前輩的 FFLogs 日誌，找出技能循環與站位的差異。</p>

      <div className="logs">
        <LogPicker label="我的日誌" storageKey="mine" onChange={setMine} />
        <LogPicker
          label="參考日誌（前輩）"
          storageKey="ref"
          preferred={preferred}
          onChange={setReference}
          picked={picked}
          action={
            <ReferenceFinder
              mine={mine}
              onPick={(url) => {
                writeLogParam('ref', url)
                setPicked({ url })
              }}
            />
          }
        />
      </div>

      {mine && reference && (
        <section className="comparison">
          <h2>比較結果</h2>
          <Comparison mine={mine} reference={reference} />
        </section>
      )}

      <SiteFooter />
    </>
  )
}

/** 頁尾：資料來源、參考專案與授權聲明（MIT 等授權要求保留版權聲明，全文在 THIRD_PARTY_NOTICES.txt）。 */
function SiteFooter() {
  const link = (href: string, text: string, title?: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title}>
      {text}
    </a>
  )
  return (
    <footer className="site-footer">
      <p className="footer-groups">
        <span>
          資料來源：{link('https://www.fflogs.com/', 'FF Logs', '戰鬥日誌（API v2）與技能圖示；繁中服排名依公開報告自行計算')}・
          {link('https://xivapi.com/', 'XIVAPI', '技能、效果、道具與 Boss 名稱等遊戲資料（Boilmaster 鏡像）')}
        </span>
        <span>
          參考：{link('https://github.com/xivanalysis/xivanalysis', 'xivanalysis', '技能窗口規則移植自其職業模組（MIT License）')}・
          {link('https://ffreplay.vjoi.cn/', 'FFReplay', '播放列與當下狀態的呈現方式')}
        </span>
        <span>
          使用：{link('https://react.dev/', 'React')}・
          {link('https://github.com/nk2028/opencc-js', 'opencc-js', '簡轉繁（MIT；辭典資料 Apache-2.0）')}
        </span>
        <a href={`${import.meta.env.BASE_URL}THIRD_PARTY_NOTICES.txt`} target="_blank" rel="noopener">
          授權聲明
        </a>
      </p>
      <p>
        FINAL FANTASY XIV © SQUARE ENIX CO., LTD. All Rights Reserved. 本站為玩家自製的非官方工具，與 SQUARE ENIX、FF Logs 無關。
      </p>
    </footer>
  )
}
