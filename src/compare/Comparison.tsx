import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { evaluateWindows, inapplicableSummary, timelineWindow } from '../analysis/windows'
import { pairedWindowRules, ruleIds, ruleName, windowRules, type WindowRule } from '../jobs/windows'
import { pairRulesByPatch, patchAt, type GamePatch } from '../jobs/patch'
import { COOLDOWN_RULES, type CooldownGroup } from '../jobs/cooldownRules'
import { cooldownUsage, downtimeWindows } from '../analysis/cooldowns'
import { Playback } from './Playback'
import { StatusPanel } from './StatusPanel'
import { Windows } from './Windows'
import { buildAlignment, pushDifferences, pushTitle } from '../analysis/alignment'
import { generateAdvice } from '../analysis/advice'
import { mechanicDifferences } from '../analysis/mechanics'
import { abilityUsage, gcdStats, lostGcdWindows } from '../analysis/metrics'
import { attachMechanics, compareTracks, distanceAt, divergences } from '../analysis/positions'
import { formatFightTime } from '../analysis/timeline'
import { fetchAbilityNames, fetchDamageSummary, type AbilityName, type DamageSummary } from '../fflogs/client'
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
        // 死亡的致命技能
        ...s.deaths.flatMap((d) => (d.abilityId === null ? [] : [d.abilityId])),
      ]),
      // 技能窗口規則中的技能：兩邊都沒用過的（例如「缺少」的技能）不在報告的技能清單中
      ...windowRules(reference.selection.player.subType).flatMap(ruleIds),
      // 冷卻技（兩邊都沒用過時也要顯示名稱）
      ...(COOLDOWN_RULES[reference.selection.player.subType] ?? []).flatMap((g) => g.ids),
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

/** 兩邊整場的 DPS／rDPS（FFLogs 傷害表）；查詢中為 undefined，查不到為 null。不阻擋比較結果。 */
function useDamageSummaries(mine: Selection, reference: Selection) {
  const [result, setResult] = useState<{ key: string; mine: DamageSummary | null; ref: DamageSummary | null } | null>(null)
  const key = `${selectionKey(mine)}|${selectionKey(reference)}`
  useEffect(() => {
    const controller = new AbortController()
    const load = (s: Selection) =>
      fetchDamageSummary(s.report.code, s.fight.id, s.player.id, controller.signal).catch(() => null)
    Promise.all([load(mine), load(reference)]).then(([m, r]) => {
      if (!controller.signal.aborted) setResult({ key, mine: m, ref: r })
    })
    return () => controller.abort()
    // selection 物件會隨名稱翻譯更新，只依 ID 組成的 key 重新查詢
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return result && result.key === key ? result : undefined
}

function sidePatch(s: Selection): GamePatch {
  return patchAt(s.report.startTime + s.fight.startTime)
}

function SummaryTable({
  mine,
  reference,
  damage,
  patches,
  mineEnd,
  refEnd,
  abilityName,
  mineToRef,
  onJump,
}: {
  mine: SideData
  reference: SideData
  /** 整場的 DPS／rDPS；查詢中為 undefined */
  damage: { mine: DamageSummary | null; ref: DamageSummary | null } | undefined
  /** 兩邊日誌的遊戲版本 */
  patches: { mine: GamePatch; ref: GamePatch }
  /** 各自時間下的比較範圍結束點 */
  mineEnd: number
  refEnd: number
  abilityName: (id: number) => string
  mineToRef: (t: number) => number
  onJump: (refTime: number) => void
}) {
  const sides = [
    { key: 'mine', label: '我', side: mine, end: mineEnd },
    { key: 'ref', label: '參考', side: reference, end: refEnd },
  ]
  // 玩家、戰鬥、結果與長度已在上方的選單顯示，這裡只列比較才有的資訊
  const rows: { label: string; cell: (s: SideData, end: number) => ReactNode }[] = [
    {
      // 死亡是最優先的改進：放在第一列，紅色標示，可點擊跳到該時間
      label: '死亡',
      cell: (s) =>
        s.deaths.length === 0 ? (
          <span className="no-death">沒有死亡</span>
        ) : (
          <span className="death-list">
            <strong className="death-count">{s.deaths.length} 次</strong>
            {s.deaths.map((d) => (
              <button
                key={d.t}
                type="button"
                className="death-chip"
                title={d.abilityId !== null ? `被「${abilityName(d.abilityId)}」擊殺` : '死亡'}
                onClick={() => onJump(s === mine ? mineToRef(d.t) : d.t)}
              >
                ✕ {formatFightTime(d.t).replace(/\.\d$/, '')}
                {d.abilityId !== null && <span className="death-cause">{abilityName(d.abilityId)}</span>}
              </button>
            ))}
          </span>
        ),
    },
    {
      // FFLogs 的 rDPS：自己的傷害扣掉隊友 Buff 加成的部分、加上自己 Buff 給隊友的貢獻（整場）
      label: 'rDPS',
      cell: (s) => {
        if (damage === undefined) return <span className="hint-inline">…</span>
        const d = s === mine ? damage.mine : damage.ref
        if (!d) return <span className="hint-inline">—</span>
        const other = s === mine ? damage.ref : damage.mine
        const round = (v: number) => Math.round(v).toLocaleString()
        return (
          <span
            className="rdps"
            title={`整場（FFLogs 計算）\nrDPS ${round(d.rdps)}＝DPS ${round(d.dps)} − 隊友 Buff 加成 ${round(d.taken)} ＋ 自己 Buff 貢獻 ${round(d.given)}\naDPS ${round(d.adps)}`}
          >
            <strong>{round(d.rdps)}</strong>
            {other && s === mine && d.rdps < other.rdps && (
              <span className="rdps-diff" title="比參考少">
                −{round(other.rdps - d.rdps)}
              </span>
            )}
          </span>
        )
      },
    },
    {
      // 依戰鬥日期對照繁中服版本；兩邊不同時標示（技能窗口依各自版本評分，差異列在表格下方）
      label: '版本',
      cell: (s) => {
        const p = s === mine ? patches.mine : patches.ref
        const differs = patches.mine.key !== patches.ref.key
        return (
          <span
            className={differs ? 'patch-differs' : undefined}
            title="依戰鬥日期對照繁中服的版本上線日期（FFLogs 的報告沒有記錄遊戲版本）"
          >
            {p.key}
          </span>
        )
      },
    },
    {
      label: '比較範圍',
      // 一定從 0:00 開始，只顯示結束點；沒被裁切的一方（戰鬥長度已在選單上）只標「全場」
      cell: (s, end) =>
        s.duration - end >= 1000 ? (
          <>
            到 {formatFightTime(end)}
            <span className="hint-inline">（之後 {((s.duration - end) / 1000).toFixed(1)} 秒不列入統計）</span>
          </>
        ) : (
          '全場'
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
    <table className="summary-table compare-summary">
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
  // 兩邊日誌的遊戲版本（依戰鬥時間對照繁中服的版本日期）
  const patches = useMemo(() => ({ mine: sidePatch(mineLoaded.selection), ref: sidePatch(refLoaded.selection) }), [mineLoaded, refLoaded])
  const damage = useDamageSummaries(mineLoaded.selection, refLoaded.selection)
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
  // 推進差距（例如轉場時 Boss 血量到了的時間不同）：只看比較範圍內
  const pushes = useMemo(
    () => pushDifferences(alignment.anchors).filter((p) => p.refEnd <= compareEnd),
    [alignment, compareEnd],
  )

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
    // 以 Boss 為中心的俯視圖用：我的 Boss 位置換算成參考時間
    const mineBossSamples = mineInRange.bossPositions.map((p) => ({ ...p, t: alignment.mineToRef(p.t) }))
    return { mineSamples, mineBossSamples, track, divergences: found }
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
    // 兩邊各自依日誌的遊戲版本選用規則（例如絕槍的終結之心 7.4 起每個窗口都要求）
    // 規則依對應的國際服版本選用（xivanalysis 依國際服版本撰寫；繁中服 7.2 的技能等同國際服 7.3）
    return pairedWindowRules(job.subType, patches.mine.rules, patches.ref.rules).map(({ mine: m, ref: r }) => {
      const reason = (p: GamePatch) => `${p.key} 版本沒有這條規則`
      return {
        mine: m ? evaluate(m, mineInRange, gcd?.mine.gcdMs ?? null) : inapplicableSummary(r!, reason(patches.mine)),
        ref: r ? evaluate(r, refInRange, gcd?.ref.gcdMs ?? null) : inapplicableSummary(m!, reason(patches.ref)),
      }
    })
  }, [job, mineInRange, refInRange, abilityName, gcd, patches])
  // 兩邊版本的規則不同的技能窗口（版本不同時列在摘要下方）
  const patchDiffs = useMemo(
    () =>
      windows
        .filter(({ mine: m, ref: r }) => m.rule !== r.rule || m.inapplicable || r.inapplicable)
        .map(({ mine: m, ref: r }) => {
          const note = (s: typeof m) => s.inapplicable ?? s.rule.patchNote ?? '一般規則'
          return `${ruleName(m.rule, abilityName)}（我 ${note(m)}／參考 ${note(r)}）`
        }),
    [windows, abilityName],
  )
  // 冷卻技是否好了就用：兩邊依各自版本的規則，只看比較範圍內；Boss 沒有位置（無法選取）的時段不算浪費
  const cooldowns = useMemo(() => {
    if (!job) return []
    // 開打當下身上有同名效果（例如武士開打前的明鏡止水）：視為開打前用了一次
    const english = (id: number) => (abilities.get(id)?.englishName ?? abilities.get(id)?.name ?? '').toLowerCase()
    const evaluate = (group: CooldownGroup, side: SideData) => {
      const prepullNames = new Set(side.prepull.map(english).filter(Boolean))
      const usedPrepull = (g: CooldownGroup) => g.ids.some((id) => prepullNames.has(english(id)))
      return cooldownUsage([group], side.playerCasts, side.duration, downtimeWindows(side.bossPositions, side.duration), usedPrepull)[0]
    }
    return pairRulesByPatch(COOLDOWN_RULES[job.subType] ?? [], patches.mine.rules, patches.ref.rules).map(({ mine: m, ref: r }) => ({
      mine: m ? evaluate(m, mineInRange) : null,
      ref: r ? evaluate(r, refInRange) : null,
    }))
  }, [job, patches, mineInRange, refInRange, abilities])
  const advice = useMemo(    () =>
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
        deaths: { mine: mineInRange.deaths, ref: refInRange.deaths },
        mineDurationMs: mineInRange.duration,
        pushes,
        cooldowns,
      }),
    [compareEnd, gcd, lost, usage, positions, abilities, abilityName, job, category, alignment, mineInRange, refInRange, mechanics, windows, mine, reference, pushes, cooldowns],
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
        <Metrics
          gcd={gcd}
          usage={usage}
          abilities={abilities}
          job={job}
          category={category}
          lost={lost}
          onFocus={jumpTo}
          cooldowns={cooldowns}
          mineToRef={alignment.mineToRef}
          abilityName={abilityName}
        />
      </>
    ),
    [advice, jumpTo, windows, abilities, abilityName, alignment, mechanics, gcd, usage, job, category, lost, cooldowns],
  )

  return (
    <>
      <SummaryTable
        mine={mine}
        reference={reference}
        damage={damage}
        patches={patches}
        mineEnd={mineInRange.duration}
        refEnd={compareEnd}
        abilityName={abilityName}
        mineToRef={alignment.mineToRef}
        onJump={jumpTo}
      />
      {patchDiffs.length > 0 && (
        <p className="hint patch-note">
          兩邊版本不同，技能窗口依各自版本的規則評分：
          {patchDiffs.map((d, i) => (
            <span key={d}>
              {i > 0 && '；'}
              {d}
            </span>
          ))}
        </p>
      )}
      <p className="hint">
        時間軸以 Boss 技能對齊：錨點 {alignment.anchors.length} 個
        {drifts.length > 0 &&
          `，參考相對於我的時間差 ${Math.min(...drifts).toFixed(1)} ～ ${Math.max(...drifts).toFixed(1)} 秒`}
        {pushes.length > 0 && (
          <>
            ；推進差距：
            {pushes.map((p) => (
              <button
                key={p.refEnd}
                type="button"
                className={`push-chip ${p.deltaMs > 0 ? 'slower' : 'faster'}`}
                onClick={() => jumpTo(p.refEnd)}
                title={pushTitle(p)}
              >
                {formatFightTime(p.refEnd)} 我{p.deltaMs > 0 ? '慢' : '快'} {(Math.abs(p.deltaMs) / 1000).toFixed(1)} 秒
              </button>
            ))}
          </>
        )}
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
        bossSamples={refInRange.bossPositions}
        mineBossSamples={positions.mineBossSamples}
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
        pushes={pushes}
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
