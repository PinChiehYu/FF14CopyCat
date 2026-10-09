import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { evaluateWindows, inapplicableSummary, timelineWindow } from '../analysis/windows'
import { pairedWindowRules, ruleIds, ruleName, windowRules, type WindowRule } from '../jobs/windows'
import { pairRulesByPatch, patchAt, type GamePatch } from '../jobs/patch'
import { COOLDOWN_RULES, type CooldownGroup } from '../jobs/cooldownRules'
import { cooldownUsage, downtimeWindows, isNonOffensiveCooldown } from '../analysis/cooldowns'
import { Playback } from './Playback'
import { StatusPanel } from './StatusPanel'
import { Windows } from './Windows'
import { buildAlignment, pushDifferences, pushTitle, type Alignment } from '../analysis/alignment'
import { generateAdvice, generateAverageAdvice, generateSoloAdvice } from '../analysis/advice'
import { deathRecap, RECAP_WINDOW_MS } from '../analysis/damageTaken'
import { mergeOverlapping } from '../analysis/buffs'
import { mainMechanicDifferences, mainMechanicGroups, mechanicOccurrences } from '../analysis/mainMechanics'
import { mechanicDifferences } from '../analysis/mechanics'
import { abilityUsage, gcdStats, idleWindows, lostGcdWindows } from '../analysis/metrics'
import { attachControl, controlStatuses, controlWindows } from '../analysis/control'
import { alignToBoss, attachBossDistances, attachMechanics, attachUntargetable, attachVariants, compareTracks, distanceAt, divergences } from '../analysis/positions'
import { formatFightTime } from '../analysis/timeline'
import { fetchAbilityNames, type AbilityName } from '../fflogs/client'
import { useSideDamage, type SideDamage } from './sideDamage'
import { abilityMap, isItemId, isPotionName, isUnnamedAbility } from '../fflogs/report'
import { badWeaves, type BadWeave } from '../analysis/weaving'
import { getJob } from '../jobs'
import { abilityCategory } from '../jobs/roleActions'
import {
  clipSide,
  incompatibility,
  loadSide,
  MEDICATED,
  unifyPotions,
  withoutAbilities,
  withoutUnnamedBossCasts,
  withSharedCasters,
  type Selection,
  type SideData,
} from './load'
import { flushSync } from 'react-dom'
import { Tabs } from '../ui/Tabs'
import { burstAlignment, burstPoints, raidBuffLabel } from '../analysis/raidBuffs'
import { RaidBuffAlignment } from './RaidBuffAlignment'
import { AdviceList } from './AdviceList'
import { HelpTip } from './HelpTip'
import { Mechanics, MechanicsHeading } from './Mechanics'
import { focusChecker, useIgnoredOccurrences } from './focusedMechanics'
import { Dots, DotsHeading } from './Dots'
import { Fillers } from './Fillers'
import { Weaving } from './Weaving'
import { lossFillerTimes, RANGED_FILLERS } from '../jobs/rangedFillers'
import { DOT_RULES, fflogsStatusId } from '../jobs/dotRules'
import { evaluateDot, type DotSummary } from '../analysis/dots'
import { Metrics } from './Metrics'
import { Positions } from './Positions'
import { DOT_CLIP_MARK_MIN_MS, Timeline, type DotMark } from './Timeline'
import { FEW_SAMPLES, tierLabel, useAverageReference, type AverageInfo } from './averageSide'
import { RefLabelContext } from './refLabel'
import type { AverageTier } from '../fflogs/client'

// 錨點太少時對齊結果不可靠
const MIN_ANCHORS = 5
// 兩人距離超過此值（yalm）視為站位不同
const DIVERGENCE_YALM = 8

function selectionKey(s: Selection): string {
  return `${s.report.code}/${s.fight.id}/${s.player.id}`
}

// 已載入（或載入中）的一側，以選擇的 ID 為鍵：換參考日誌時我的資料不必重抓。每側約 1.4 MB，只留最近幾筆
const SIDE_CACHE_SIZE = 4
const sideCache = new Map<string, Promise<SideData>>()

function cachedSide(selection: Selection): Promise<SideData> {
  const key = selectionKey(selection)
  const hit = sideCache.get(key)
  if (hit) {
    // 移到最新
    sideCache.delete(key)
    sideCache.set(key, hit)
    return hit
  }
  // 多個畫面共用同一個請求，不隨單一畫面卸載而中止
  const loading = loadSide(selection)
  loading.catch(() => sideCache.delete(key))
  sideCache.set(key, loading)
  while (sideCache.size > SIDE_CACHE_SIZE) sideCache.delete(sideCache.keys().next().value!)
  return loading
}

/** 載入一側的事件（兩側分開載入：我的先好就先顯示）；沒有選擇時為 null。 */
function useSide(selection: Selection | null) {
  const [result, setResult] = useState<{ key: string; side?: SideData; error?: string } | null>(null)
  const key = selection ? selectionKey(selection) : null
  // 只在選擇的戰鬥或角色改變時重新載入；Boss 繁中名稱晚到會換掉 Selection 物件，但資料不變
  const latest = useRef(selection)
  useLayoutEffect(() => {
    latest.current = selection
  })

  useEffect(() => {
    if (key === null || !latest.current) return
    let active = true
    cachedSide(latest.current)
      .then((side) => active && setResult({ key, side }))
      .catch((err: unknown) => active && setResult({ key, error: err instanceof Error ? err.message : String(err) }))
    return () => {
      active = false
    }
  }, [key])

  return key !== null && result?.key === key ? result : null
}

// 普通攻擊（Action 7，繁中「攻擊」）
const AUTO_ATTACK = 7

/** 查詢兩邊出現過的技能的繁中名稱；查詢失敗時沿用 FFLogs 的英文名稱。 */
function useAbilityNames(mine: SideData, reference: SideData | null): Map<number, AbilityName> {
  const [names, setNames] = useState<Map<number, AbilityName>>(new Map())
  useEffect(() => {
    const job = mine.selection.player.subType
    const ids = [
      ...(reference ? [mine, reference] : [mine]).flatMap((s) => [
        ...[...s.playerCasts, ...s.autoAttacks, ...s.bossCasts].map((c) => c.abilityId),
        // 效果（開打前、技能窗口）
        ...s.prepull,
        ...s.buffs.map((b) => b.statusId),
        // Boss 施加在玩家身上的 debuff（控場的名稱）
        ...s.bossDebuffs.map((b) => b.statusId),
        // 當下狀態面板：角色自身的效果
        ...s.auras.filter((a) => a.sourceId === s.selection.player.id).map((a) => a.statusId),
        // 團隊 Buff（爆發與團隊 Buff、時間軸的團隊 Buff 列）
        ...(s.raidBuffs ?? []).map((w) => w.statusId),
        // 死亡的致命技能
        ...s.deaths.flatMap((d) => (d.abilityId === null ? [] : [d.abilityId])),
        // 死亡回顧（死亡建議的說明）：死前受到的傷害
        ...s.deaths.flatMap((d) => s.damageTaken.filter((h) => h.t > d.t - RECAP_WINDOW_MS && h.t <= d.t).map((h) => h.abilityId)),
      ]),
      // 技能窗口規則中的技能：兩邊都沒用過的（例如「缺少」的技能）不在報告的技能清單中
      ...windowRules(job).flatMap(ruleIds),
      // 冷卻技（兩邊都沒用過時也要顯示名稱）
      ...(COOLDOWN_RULES[job] ?? []).flatMap((g) => g.ids),
      // DoT 效果
      ...(DOT_RULES[job] ?? []).flatMap((r) => r.statusIds.map(fflogsStatusId)),
      // 普通攻擊（沒有名稱的 Boss 普通攻擊沿用它的名稱）
      AUTO_ATTACK,
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
  average,
}: {
  mine: SideData
  /** 還沒有參考日誌時為 null：只有我的一欄，不列比較範圍 */
  reference: SideData | null
  /** 參考為前輩平均：rDPS 為樣本的中位數、PR 為區間、版本為樣本中最常見的；死亡與開打前沒有 */
  average?: AverageInfo
  /** 整場的 DPS／rDPS 與繁中服 PR；查詢中為 undefined */
  damage: { mine: SideDamage | undefined; ref: SideDamage | undefined }
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
    ...(reference ? [{ key: 'ref', label: average ? '前輩平均' : '參考', side: reference, end: refEnd }] : []),
  ]
  const damageOf = (s: SideData) => (s === mine ? damage.mine : damage.ref)
  // 兩邊都有的開打前效果（放在「開打前」的說明裡）
  const sharedPrepull = reference ? mine.prepull.filter((id) => reference.prepull.includes(id)) : []
  const prCount = damage.mine?.pr?.count ?? damage.ref?.pr?.count
  // 玩家、戰鬥、結果與長度已在上方的選單顯示，這裡只列比較才有的資訊。
  // 各列的說明放在列名旁的「?」（help），格子裡只放資料
  const rows: { label: string; help?: string; cell: (s: SideData, end: number) => ReactNode }[] = [
    {
      // 死亡是最優先的改進：放在第一列，紅色標示，可點擊跳到該時間
      label: '死亡',
      cell: (s) =>
        // 沒有死亡只顯示「—」；有的話列出每次死亡的時間（可點擊跳到該處）與死因
        s.deaths.length === 0 ? (
          <span className="hint-inline">—</span>
        ) : (
          <span className="death-list">
            {s.deaths.map((d) => (
              <button
                key={d.t}
                type="button"
                className="death-chip"
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
      help: `整場的 rDPS（FFLogs 計算）＝DPS − 隊友 Buff 加成 ＋ 自己 Buff 貢獻，比 DPS 更能反映個人表現。${reference ? '紅字為比參考少的差距。' : ''}滑鼠停在數字上可看各項數值與 aDPS。`,
      cell: (s) => {
        const round = (v: number) => Math.round(v).toLocaleString()
        if (average && s !== mine) {
          return average.rdps === null ? (
            <span className="hint-inline">—</span>
          ) : (
            <span className="rdps" title={`${average.samples.length} 位前輩的 rDPS 中位數`}>
              <strong>{round(average.rdps)}</strong>
            </span>
          )
        }
        const side = damageOf(s)
        if (side === undefined) return <span className="hint-inline">…</span>
        const d = side.summary
        if (!d) return <span className="hint-inline">—</span>
        const other = s === mine ? (average ? (average.rdps === null ? undefined : { rdps: average.rdps }) : damage.ref?.summary) : undefined
        return (
          <span
            className="rdps"
            title={`整場（FFLogs 計算）\nrDPS ${round(d.rdps)}＝DPS ${round(d.dps)} − 隊友 Buff 加成 ${round(d.taken)} ＋ 自己 Buff 貢獻 ${round(d.given)}\naDPS ${round(d.adps)}`}
          >
            <strong>{round(d.rdps)}</strong>
            {other && d.rdps < other.rdps && <span className="rdps-diff">−{round(other.rdps - d.rdps)}</span>}
          </span>
        )
      },
    },
    {
      // 這場的 rDPS 在繁中服排名（Worker 掃描的公開日誌）中的百分位；未擊殺或沒有資料時「—」
      label: 'PR',
      help: `繁中服 PR：這場的 rDPS 與本站收錄的繁中服${prCount ? ` ${prCount} 位` : ''}同職業玩家各自最好的一場比較（自己已在排名中時不和自己比），同「搜尋前輩日誌」的 PR。未擊殺、沒有這個職業的排名資料或排名資料庫暫時無法使用時為「—」。`,
      cell: (s) => {
        if (average && s !== mine) return <strong>{tierLabel(average.tier)}</strong>
        const side = damageOf(s)
        if (side === undefined) return <span className="hint-inline">…</span>
        if (!side.pr) return <span className="hint-inline">—</span>
        return <strong>{side.pr.pr}</strong>
      },
    },
    {
      // 依戰鬥日期對照繁中服版本；兩邊不同時標示（技能窗口依各自版本評分，差異列在表格下方）
      label: '版本',
      help: `依戰鬥日期對照繁中服的版本上線日期（FFLogs 的報告沒有記錄遊戲版本）。${reference ? '兩邊不同時變色，技能窗口依各自版本的規則評分。' : ''}`,
      cell: (s) => {
        const refKey = average ? average.patch : patches.ref.key
        const differs = refKey !== null && patches.mine.key !== refKey
        return <span className={differs ? 'patch-differs' : undefined}>{s === mine ? patches.mine.key : (refKey ?? '—')}</span>
      },
    },
    ...(reference === null ? [] : [{
      label: '範圍',
      help: '比較範圍：兩場都在進行的時段才列入統計，一定從 0:00 開始。較長的一方只比到另一方結束，「−N.Ns」為之後不列入統計的秒數；沒被裁切的一方為「全場」。',
      // 一定從 0:00 開始，只顯示結束點；沒被裁切的一方（戰鬥長度已在選單上）只標「全場」
      cell: (s: SideData, end: number) =>
        s.duration - end >= 1000 ? (
          <span>
            到 {formatFightTime(end)} <span className="hint-inline">−{((s.duration - end) / 1000).toFixed(1)}s</span>
          </span>
        ) : (
          '全場'
        ),
    }]),
    {
      // FFLogs 沒有開打前的施放事件，以開打當下身上的自身效果推知；只列對方沒有的效果，兩邊都有的放在滑鼠提示。
      // 沒有參考時全部列出
      label: '開打前',
      help: [
        '開打當下身上已有的自身效果，推知開打前用過的技能（FFLogs 沒有開打前的施放紀錄）。',
        reference && '每邊只列對方沒有的效果；兩邊完全相同時為「相同」。',
        sharedPrepull.length > 0 && `兩邊都有：${sharedPrepull.map(abilityName).join('、')}`,
      ]
        .filter(Boolean)
        .join('\n'),
      cell: (s) => {
        // 只在名稱之間換行（「自生II」不拆成兩行）
        const names = (ids: number[], className: string) => (
          <span>
            {ids.map((id, i) => (
              <span key={id}>
                {i > 0 && '、'}
                <span className={className}>{abilityName(id)}</span>
              </span>
            ))}
          </span>
        )
        if (s.prepull.length === 0) return <span className="hint-inline">—</span>
        // 前輩平均沒有開打前的效果：只列我的
        if (!reference || average) return names(s.prepull, 'prepull-name')
        const other = s === mine ? reference : mine
        const only = s.prepull.filter((id) => !other.prepull.includes(id))
        if (only.length === 0) {
          // 兩邊完全相同才寫「相同」；對方多了效果時這邊沒有可列的
          const same = other.prepull.every((id) => s.prepull.includes(id))
          return <span className="hint-inline">{same ? '相同' : '—'}</span>
        }
        return names(only, 'prepull-name prepull-only')
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
            <th>
              {row.label}
              {row.help && <HelpTip text={row.help} />}
            </th>
            {sides.map((s) => (
              <td key={s.key}>{row.cell(s.side, s.end)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// 還沒有參考日誌時的時間對應：參考時間＝我的時間
const IDENTITY: Alignment = { anchors: [], mineToRef: (t) => t, refToMine: (t) => t }

/**
 * 比較結果。refLoaded 為 null（還沒選參考日誌或載入中）時只顯示我的日誌能做的分析：
 * 以我自己代替參考計算（參考時間＝我的時間），需要比較的部分（機制差異、站位差異、GCD 差距等）不顯示。
 * @param notice 顯示在摘要下方的狀態（參考日誌載入中、無法比較的原因等）
 */
function Loaded({
  mine: mineLoaded,
  reference: refLoaded,
  notice,
  average,
}: {
  mine: SideData
  reference: SideData | null
  notice?: ReactNode
  /** 參考為前輩平均（refLoaded 為合成的參考，見 averageSide.ts） */
  average?: AverageInfo
}) {
  const solo = refLoaded === null
  // 前輩平均只有施放（已換成我的時間）：需要逐場資料的比較（機制、站位、技能窗口、DoT…）比照只有我的日誌
  const partial = solo || !!average
  const job = getJob(mineLoaded.selection.player.subType)
  // 兩邊日誌的遊戲版本（依戰鬥時間對照繁中服的版本日期）
  const patches = useMemo(
    () => ({ mine: sidePatch(mineLoaded.selection), ref: sidePatch((refLoaded ?? mineLoaded).selection) }),
    [mineLoaded, refLoaded],
  )
  const damage = { mine: useSideDamage(mineLoaded.selection), ref: useSideDamage(average ? null : (refLoaded?.selection ?? null)) }
  // 不需紀錄的技能（挑釁、退避、坦姿開關）一開始就移除
  const category = useMemo(() => (id: number) => abilityCategory(id, job), [job])
  // 只在一邊日誌中有施放紀錄的敵人（例如只被一邊記錄的雜兵）不比較，也不用來對齊
  const [mineShared, refShared] = useMemo(
    () => (refLoaded && !average ? withSharedCasters(mineLoaded, refLoaded) : [mineLoaded, refLoaded ?? mineLoaded]),
    [mineLoaded, refLoaded, average],
  )
  // 沒有名稱的 Boss 技能（Boss 的演出動作等）只用來對齊時間軸，其餘都不顯示
  // cactbot 同一條目的不同版本（放入 A／B 面等）從第一次對齊就當成同一個機制
  const alignment = useMemo(
    () =>
      partial
        ? IDENTITY
        : buildAlignment(mineShared.bossCasts, refShared.bossCasts, {
            knownGroups: mainMechanicGroups(mineShared.selection.fight.encounterID) ?? undefined,
          }),
    [mineShared, refShared, partial],
  )
  // 兩邊的強化藥統一成同一個 ID（依使用後得到的強化藥效果判斷，見 unifyPotions）
  // 沒有參考時 reference 是我自己（各項計算的參考時間＝我的時間）；顯示時用 shownRef 判斷有沒有參考
  const { mine, ref: reference, potionId } = useMemo(() => {
    const prepare = (side: SideData) => withoutUnnamedBossCasts(withoutAbilities(side, (id) => category(id) === 'ignored'))
    const m = prepare(mineShared)
    return unifyPotions(m, solo ? m : prepare(refShared))
  }, [mineShared, refShared, category, solo])
  const shownRef = solo ? null : reference
  const zhNames = useAbilityNames(mine, shownRef)
  // 顯示用：有繁中名稱時取代 FFLogs 的英文名稱，英文保留在 englishName
  const abilities = useMemo(() => {
    const merged = new Map([...abilityMap(mine.selection.report), ...abilityMap(reference.selection.report)])
    for (const [id, ability] of merged) {
      // Boss 的普通攻擊常是各 Boss 專用、遊戲資料沒有名稱的技能（例如 #42228），FFLogs 記為 Attack：沿用普通攻擊的繁中名稱
      const zh = zhNames.get(id) ?? (ability.name === 'Attack' ? zhNames.get(AUTO_ATTACK) : undefined)
      if (zh) merged.set(id, { ...ability, name: zh.name, englishName: ability.name })
    }
    // 道具 ID 對不上遊戲資料時（例如強化藥記成武器），依效果判定的強化藥改以「強化藥」顯示
    const potion = potionId === null ? undefined : merged.get(potionId)
    if (potion && !isPotionName(potion.englishName ?? potion.name)) {
      // 圖示也是錯的道具，改用強化藥效果的圖示
      const icon = merged.get(MEDICATED)?.icon ?? potion.icon
      merged.set(potionId!, { ...potion, name: '強化藥', englishName: `Potion (item #${potionId})`, icon })
    }
    return merged
  }, [mine, reference, zhNames, potionId])
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

  // Boss 強制控場：兩份日誌中每次期間都沒有開始 GCD 的 Boss debuff（兩邊各自的施加時間可以不同，也可以只有一邊有）
  const control = useMemo(() => {
    if (!job) return new Set<number>()
    const gcds = (side: SideData) => side.playerCasts.filter((c) => job.isGcd(c.abilityId)).map((c) => c.t)
    return controlStatuses([
      { debuffs: mineInRange.bossDebuffs, gcds: gcds(mineInRange) },
      { debuffs: refInRange.bossDebuffs, gcds: gcds(refInRange) },
    ])
  }, [mineInRange, refInRange, job])
  // 同時施加的無名稱效果（FFLogs 的 Unknown_xxxx）不列出名稱
  const namedStatus = useCallback(
    (id: number) => !isUnnamedAbility(abilities.get(id)?.englishName ?? abilities.get(id)?.name),
    [abilities],
  )
  // 當下狀態的最近技能依 GCD 分組；職業沒有規則時全部視為 GCD（不分組）
  const isGcd = useCallback((id: number) => (job ? job.isGcd(id) : true), [job])

  const { gcd, lost } = useMemo(() => {
    if (!job) return { gcd: null, lost: [] }
    const gcds = (side: SideData) => side.playerCasts.filter((c) => job.isGcd(c.abilityId)).map((c) => c.t)
    const mineGcds = gcds(mineInRange)
    const refGcds = gcds(refInRange)
    const stats = { mine: gcdStats(mineGcds), ref: gcdStats(refGcds) }
    const gcdMs = stats.mine.gcdMs
    // 沒有參考：列出自己的停手（扣掉 Boss 無法選中與死亡的時間）
    const excluded = [
      ...mineInRange.untargetable,
      ...mineInRange.deaths.map((d) => ({ start: d.t, end: d.revivedAt ?? mineInRange.duration })),
    ]
    const windows =
      gcdMs === null ? [] : solo ? idleWindows(mineGcds, gcdMs, excluded) : lostGcdWindows(mineGcds, refGcds, alignment.mineToRef, gcdMs)
    // 控場造成的停手另外標示，不算操作問題
    const lost = attachControl(windows, controlWindows(mineInRange.bossDebuffs, control)).map((w) =>
      w.control ? { ...w, control: w.control.filter(namedStatus) } : w,
    )
    // 前輩平均：GCD 數、間隔與空檔為每位前輩各自計算的中位數
    const ref = average?.gcd ?? stats.ref
    return { gcd: solo ? { mine: stats.mine, ref: null } : { mine: stats.mine, ref }, lost }
  }, [mineInRange, refInRange, alignment, job, control, namedStatus, solo, average])
  // 技能使用次數含普通攻擊（時間軸不畫）；次數多寡可反映是否離 Boss 太遠或停手
  const usage = useMemo(
    () =>
      abilityUsage(
        // 前輩平均沒有普通攻擊：兩邊都不列
        [...mineInRange.playerCasts, ...(average ? [] : mineInRange.autoAttacks)],
        solo ? [] : [...refInRange.playerCasts, ...refInRange.autoAttacks],
        alignment.mineToRef,
      ),
    [mineInRange, refInRange, alignment, solo, average],
  )
  const mechanics = useMemo(
    () =>
      partial
        ? []
        : mechanicDifferences(
        mine.bossCasts,
        reference.bossCasts,
        alignment.mineToRef,
        alignment.mineToRef(mine.duration),
        reference.duration,
        { pushes },
      ),
    [mine, reference, alignment, pushes, partial],
  )
  // 機制差異表只列主要機制（cactbot 時間軸列出的技能）；站位與建議仍用全部低頻技能
  const mainMechanics = useMemo(
    () =>
      partial
        ? []
        : mainMechanicDifferences(
        mine.selection.fight.encounterID,
        mine.bossCasts,
        reference.bossCasts,
        alignment.mineToRef,
        alignment.mineToRef(mine.duration),
        reference.duration,
        { pushes },
      ),
    [mine, reference, alignment, pushes, partial],
  )
  const positions = useMemo(() => {
    const mineSamples = mineInRange.playerPositions.map((p) => ({ ...p, t: alignment.mineToRef(p.t) }))
    // 我的 Boss 位置換算成參考時間（以 Boss 為中心、兩個 Boss 的俯視圖與對齊用）
    const mineBossSamples = mineInRange.bossPositions.map((p) => ({ ...p, t: alignment.mineToRef(p.t) }))
    if (partial) {
      // 沒有參考（或前輩平均，沒有位置）：軌跡只有我，沒有站位差異
      const track = compareTracks(mineSamples, [], mineBossSamples, compareEnd)
      return { mineSamples, mineAlignedSamples: mineSamples, mineBossSamples, track, divergences: [] }
    }
    // 俯視圖「對齊 Boss」用：我的位置平移到參考 Boss 的位置
    const mineAlignedSamples = alignToBoss(mineSamples, mineBossSamples, reference.bossPositions)
    // 距離與站位差異以場地上的位置計算；兩場 Boss 站在不同位置時改以各自 Boss 為基準（依 Boss 面向旋轉，見 compareTracks）
    const track = compareTracks(mineSamples, refInRange.playerPositions, reference.bossPositions, compareEnd, {
      mineBoss: mineBossSamples,
    })
    // 標示每段差異期間、兩人仍相距超過門檻時結算的 Boss 機制（兩邊的 Boss 施放都列出），
    // 兩邊隨機機制不同的（例如熱舞綠光 A 面／B 面的先後）：站位不同可能是機制造成，
    // 以及任一邊 Boss 無法選中（轉場等，玩家常被強制移動或無法移動）的
    // 並附上機制結算當下兩人各自離自己 Boss 的距離：相對於各自 Boss 位置相近的不算站位不同
    const withMechanics = attachBossDistances(
      attachMechanics(
        divergences(track, DIVERGENCE_YALM),
        { mine: mineInRange.bossCasts, ref: refInRange.bossCasts, mineToRef: alignment.mineToRef },
        (t) => distanceAt(track, t),
        DIVERGENCE_YALM,
      ),
      { mine: mineSamples, ref: refInRange.playerPositions, mineBoss: mineBossSamples, refBoss: reference.bossPositions },
      DIVERGENCE_YALM,
    )
    const untargetable = [
      ...refInRange.untargetable,
      ...mineInRange.untargetable.map((s) => ({ start: alignment.mineToRef(s.start), end: alignment.mineToRef(s.end) })),
    ]
    const found = attachUntargetable(attachVariants(withMechanics, mechanics), untargetable)
    return { mineSamples, mineAlignedSamples, mineBossSamples, track, divergences: found }
  }, [mineInRange, refInRange, reference, alignment, compareEnd, mechanics, partial])
  // 報告技能清單中沒有的（兩邊都沒用過）也用查到的繁中名稱
  const abilityName = useCallback(
    (id: number) => {
      const name = abilities.get(id)?.name ?? zhNames.get(id)?.name
      if (name === undefined) return `#${id}`
      // FFLogs 的 unknown_<16 進位 ID>：遊戲資料沒有名稱
      return isUnnamedAbility(name) ? '無名稱技能' : name
    },
    [abilities, zhNames],
  )
  // 技能窗口（xivanalysis 式的職業規則）：兩邊各自評分，只看比較範圍內
  const windows = useMemo(() => {
    if (!job) return []
    // 各自的 GCD 間隔用來依窗口長度封頂應打的 GCD 數
    // fightEndMs：這一側實際的戰鬥長度，被擊殺截斷的窗口照常評分但放寬（被比較範圍截斷的不評分）
    const evaluate = (rule: WindowRule, side: SideData, gcdMs: number | null, fightEndMs: number) =>
      evaluateWindows(rule, side.buffs, side.playerCasts, job.isGcd, abilityName, gcdMs, side.duration, fightEndMs)
    // 兩邊各自依日誌的遊戲版本選用規則（例如絕槍的終結之心 7.4 起每個窗口都要求）
    // 規則依對應的國際服版本選用（xivanalysis 依國際服版本撰寫；繁中服 7.2 的技能等同國際服 7.3）
    return pairedWindowRules(job.subType, patches.mine.rules, patches.ref.rules).map(({ mine: m, ref: r }) => {
      const reason = (p: GamePatch) => `${p.key} 版本沒有這條規則`
      return {
        mine: m ? evaluate(m, mineInRange, gcd?.mine.gcdMs ?? null, mine.duration) : inapplicableSummary(r!, reason(patches.mine)),
        // 沒有參考時兩邊版本相同，m 一定有；前輩平均沒有效果時段
        ref: partial
          ? null
          : r
            ? evaluate(r, refInRange, gcd?.ref?.gcdMs ?? null, reference.duration)
            : inapplicableSummary(m!, reason(patches.ref)),
      }
    })
  }, [job, mineInRange, refInRange, abilityName, gcd, patches, mine.duration, reference.duration, partial])
  // 兩邊版本的規則不同的技能窗口（版本不同時列在摘要下方）
  const patchDiffs = useMemo(
    () =>
      windows
        .flatMap(({ mine: m, ref: r }) => (r ? [{ mine: m, ref: r }] : []))
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
      ref: r && !partial ? evaluate(r, refInRange) : null,
      nonOffensive: isNonOffensiveCooldown((m ?? r)!, job),
    }))
  }, [job, patches, mineInRange, refInRange, abilities, partial])
  // DoT 覆蓋率與提早續上：兩邊各自、只看比較範圍內
  const dots = useMemo(
    () =>
      (DOT_RULES[mine.selection.player.subType] ?? []).map((rule) => ({
        mine: evaluateDot(rule, mineInRange),
        ref: partial ? null : evaluateDot(rule, refInRange),
      })),
    [mine, mineInRange, refInRange, partial],
  )
  // 止損技：兩邊算止損的施放時間（各自的時間、比較範圍內；開場起手與強化效果中的不算）
  const fillerId = RANGED_FILLERS[mine.selection.player.subType]
  const fillers = useMemo(() => {
    if (fillerId === undefined) return null
    const isGcd = (id: number) => (job ? job.isGcd(id) : true)
    const times = (side: SideData) => [...lossFillerTimes(side, isGcd)].sort((a, b) => a - b)
    return { mine: times(mineInRange), ref: partial ? null : times(refInRange) }
  }, [fillerId, job, mineInRange, refInRange, partial])
  // 穿插過多導致 GCD 延後（xivanalysis 的 Weaving）：兩邊各自、比較範圍內
  const weaving = useMemo(() => {
    if (!job) return null
    const subType = mine.selection.player.subType
    const find = (side: SideData, gcdMs: number | null) => badWeaves(side, subType, job.isGcd, isItemId, gcdMs)
    return {
      mine: find(mineInRange, gcd?.mine.gcdMs ?? null),
      ref: partial ? null : find(refInRange, gcd?.ref?.gcdMs ?? null),
    }
  }, [job, mine, mineInRange, refInRange, gcd, partial])
  const englishName = useCallback(
    (id: number) => {
      const a = abilities.get(id)
      return a?.englishName ?? a?.name ?? `#${id}`
    },
    [abilities],
  )
  // 爆發與團隊 Buff 的對齊（只看我的日誌）：爆發＝冷卻 60 秒以上的輸出冷卻技與強化藥；沒有團隊 Buff 資料（前輩平均等合成資料）時為 null
  const bursts = useMemo(() => {
    if (!mineInRange.raidBuffs) return null
    const groups = (job ? (COOLDOWN_RULES[job.subType] ?? []) : []).filter((g) => g.cooldownMs >= 60_000 && !isNonOffensiveCooldown(g, job))
    const ids = new Set(groups.flatMap((g) => g.ids))
    const isPotion = (id: number) => isItemId(id) && isPotionName(englishName(id))
    const isBurst = (id: number) => ids.has(id) || isPotion(id)
    // 附帶的自身效果：與技能同名（強化藥為「Medicated」）、使用後 1.5 秒內開始的效果時段（xivanalysis 的 BuffWindow）
    const buffEnd = (id: number, t: number) => {
      const name = isPotion(id) ? 'Medicated' : englishName(id)
      return mineInRange.buffs.find((b) => b.start >= t - 500 && b.start <= t + 1500 && englishName(b.statusId) === name)?.end
    }
    return burstAlignment(burstPoints(mineInRange.playerCasts, isBurst, buffEnd), mineInRange.raidBuffs)
  }, [mineInRange, job, englishName])
  // 死亡回顧（死亡建議的說明）：死前幾擊與參考在同一時間吃同一招的情形
  const deathRecaps = useMemo(() => {
    const refHits = partial ? null : refInRange.damageTaken
    return mineInRange.deaths.map((d) =>
      deathRecap(d, mineInRange.damageTaken, refHits && { hits: refHits, deaths: refInRange.deaths }, alignment.mineToRef),
    )
  }, [mineInRange, refInRange, partial, alignment])
  const advice = useMemo(() => {
    const soloInput: Parameters<typeof generateSoloAdvice>[0] = {
        abilityName,
        deaths: mineInRange.deaths,
        durationMs: mineInRange.duration,
        stops: lost,
        windows: windows.map((w) => w.mine),
        cooldowns,
        // 傷害降低（Damage Down）：機制失誤的懲罰，依英文名稱判斷
        penalties: mergeOverlapping(mineInRange.bossDebuffs.filter((b) => englishName(b.statusId) === 'Damage Down')),
        // 強化藥：得到強化藥效果的次數（含開打前）
        potionUses: mineInRange.buffs.filter((b) => b.statusId === MEDICATED).length,
        dots,
        fillers: fillers?.mine,
        weaving: weaving?.mine,
        subType: mine.selection.player.subType,
        fillerId,
        deathRecaps,
        bursts: bursts ?? undefined,
    }
    if (solo) return generateSoloAdvice(soloInput)
    const compareInput: Parameters<typeof generateAdvice>[0] = {
      mechanics,
      durationMs: compareEnd,
      gcd: gcd?.ref ? { mine: gcd.mine, ref: gcd.ref } : null,
      lost,
      usage,
      divergences: positions.divergences,
      track: positions.track,
      abilityName,
      englishName,
      isGcd: job?.isGcd,
      isHeal: (id) => !!mine.healOnly?.includes(id) || !!reference.healOnly?.includes(id),
      category,
      mineToRef: alignment.mineToRef,
      firstUse: (id) => mineInRange.playerCasts.find((c) => c.abilityId === id)?.t,
      windows: windows.flatMap(({ mine: m, ref: r }) => (r ? [{ mine: m, ref: r }] : [])),
      prepull: { mine: mine.prepull, ref: reference.prepull },
      deaths: { mine: mineInRange.deaths },
      mineDurationMs: mineInRange.duration,
      cooldowns,
      dots,
      fillers: fillers?.ref ? { mine: fillers.mine, ref: fillers.ref } : undefined,
      weaving: weaving?.ref ? { mine: weaving.mine, ref: weaving.ref } : undefined,
      subType: mine.selection.player.subType,
      fillerId,
      deathRecaps,
      bursts: bursts ?? undefined,
      penalties: { mine: mergeOverlapping(mineInRange.bossDebuffs.filter((b) => englishName(b.statusId) === 'Damage Down')) },
    }
    return average ? generateAverageAdvice(soloInput, compareInput) : generateAdvice(compareInput)
  }, [average, bursts, deathRecaps, solo, compareEnd, gcd, lost, usage, positions, englishName, abilityName, job, category, alignment, mineInRange, mechanics, windows, mine, reference, cooldowns, dots, fillers, fillerId, weaving])

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
  // 建議與站位之間的詳細區塊分頁顯示（輸出循環／Boss 機制），避免整頁過長；站位與當下狀態、時間軸一直顯示在下方，方便配合播放
  const [detail, setDetail] = useState<string>('rotation')
  // 「查看」頁面上的區塊：切到區塊所在的分頁（分頁都保持掛載，可直接找到），顯示後再捲動
  const showSection = useCallback((id: string) => {
    const tab = document.getElementById(id)?.closest<HTMLElement>('[data-detail]')?.dataset.detail
    if (tab) flushSync(() => setDetail(tab))
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [setDetail])
  const playbackEnd = Math.max(reference.duration, alignment.mineToRef(mine.duration))
  // 時間軸的標示：固定下來，時間軸的技能列才不會在播放時重繪
  const timelineHighlights = useMemo(() => lost.map((w) => ({ start: w.mineStart, end: w.mineEnd })), [lost])
  const timelineWindows = useMemo(
    () =>
      windows.flatMap(({ mine: m, ref: r }) => [
        ...m.windows.map((w) => ({ ...timelineWindow(w, ruleName(m.rule, abilityName)), side: 'mine' as const })),
        ...(r?.windows ?? []).map((w) => ({ ...timelineWindow(w, ruleName(r!.rule, abilityName)), side: 'ref' as const })),
      ]),
    [windows, abilityName],
  )
  // 在「搜尋前輩日誌」中關注的機制時間點（我這場的第 N 次）：有取消勾選時，比較結果中對到的地方高光
  const encounter = mine.selection.fight.encounterID
  const [ignoredOccurrences] = useIgnoredOccurrences(encounter)
  const occurrences = useMemo(() => mechanicOccurrences(encounter, mineLoaded.bossCasts), [encounter, mineLoaded])
  const isFocused = useMemo(
    () =>
      focusChecker(encounter, occurrences, ignoredOccurrences, (id) => {
        const a = abilities.get(id)
        return a?.englishName ?? a?.name
      }),
    [encounter, occurrences, ignoredOccurrences, abilities],
  )
  const weaveMarks = useMemo(() => {
    const marks = (list: BadWeave[] | null | undefined, side: 'mine' | 'ref') =>
      (list ?? []).map((w) => ({
        side,
        start: w.start,
        end: w.end,
        title: `穿插過多：${w.weaves.map((a) => abilityName(a.abilityId)).join('、')}（${w.weaves.length} 個，可 ${Math.max(0, w.allowed)}），GCD 晚 ${(w.delayMs / 1000).toFixed(1)} 秒`,
      }))
    return [...marks(weaving?.mine, 'mine'), ...marks(weaving?.ref, 'ref')]
  }, [weaving, abilityName])
  // DoT 斷掉與提早續上（各自的時間、比較範圍內）
  const dotMarks = useMemo(() => {
    const marks = (summary: DotSummary | null, side: 'mine' | 'ref'): DotMark[] => {
      if (!summary) return []
      const dotName = summary.rule.statusIds.map((id) => abilityName(fflogsStatusId(id))).join('／')
      return [
        ...summary.gaps.map((g) => ({
          side,
          kind: 'gap' as const,
          start: g.start,
          end: g.end,
          title: `${dotName} 斷掉 ${formatFightTime(g.start)}～${formatFightTime(g.end)}（${((g.end - g.start) / 1000).toFixed(1)} 秒）`,
        })),
        // 在一個 GCD 內續上是正常打法，只標覆蓋掉超過一個 GCD 的
        ...(summary.clipPerMinMs === null ? [] : summary.clips.filter((c) => c.ms >= DOT_CLIP_MARK_MIN_MS)).map((c) => ({
          side,
          kind: 'clip' as const,
          start: c.t,
          end: c.t,
          title: `${dotName} 提早續上 ${formatFightTime(c.t)}（覆蓋掉 ${(c.ms / 1000).toFixed(1)} 秒）`,
        })),
      ]
    }
    return dots.flatMap((d) => [...marks(d.mine, 'mine'), ...marks(d.ref, 'ref')])
  }, [dots, abilityName])

  // 不隨游標變動的區塊先做好，播放時游標每秒更新多次，不必跟著重繪
  const adviceSection = useMemo(
    () => (
      <>
        <h3>建議</h3>
        <AdviceList advice={advice} onJump={jumpTo} onSection={showSection} />
      </>
    ),
    [advice, jumpTo, showSection],
  )
  const rotationSection = useMemo(
    () => (
      <>
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
        {bursts && bursts.length > 0 && (
          <RaidBuffAlignment
            bursts={bursts}
            raidBuffName={raidBuffLabel(mineInRange.raidBuffs ?? [], (id) => abilities.get(id)?.name)}
            abilities={abilities}
            abilityName={abilityName}
            mineToRef={alignment.mineToRef}
            onJump={jumpTo}
          />
        )}
        {dots.length > 0 && (
          <>
            <DotsHeading />
            <Dots dots={dots} abilities={abilities} abilityName={abilityName} mineToRef={alignment.mineToRef} onJump={jumpTo} />
          </>
        )}
        <Metrics
          solo={solo}
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
          afterGcd={
            <>
              {weaving && weaving.mine.length > 0 && (
                <div className="metric-block">
                  <Weaving weaving={weaving} abilities={abilities} abilityName={abilityName} mineToRef={alignment.mineToRef} onJump={jumpTo} />
                </div>
              )}
              {fillers && fillerId !== undefined && (
                <div className="metric-block">
                  <Fillers
                    fillerId={fillerId}
                    fillers={fillers}
                    abilities={abilities}
                    abilityName={abilityName}
                    mineToRef={alignment.mineToRef}
                    onJump={jumpTo}
                  />
                </div>
              )}
            </>
          }
        />
      </>
    ),
    [solo, jumpTo, windows, bursts, mineInRange.raidBuffs, dots, fillers, fillerId, weaving, abilities, abilityName, alignment, gcd, usage, job, category, lost, cooldowns],
  )
  const mechanicsSection = useMemo(
    () =>
      !partial && (
        <>
          <MechanicsHeading main={mainMechanicGroups(mine.selection.fight.encounterID) !== null} />
          <Mechanics
            differences={mainMechanics}
            main={mainMechanicGroups(mine.selection.fight.encounterID) !== null}
            abilityName={abilityName}
            onJump={jumpTo}
            isFocused={isFocused}
            refToMine={alignment.refToMine}
          />
        </>
      ),
    [partial, mine, mainMechanics, abilityName, jumpTo, isFocused, alignment],
  )

  return (
    <RefLabelContext.Provider value={average ? '前輩平均' : '參考'}>
      <SummaryTable
        mine={mine}
        reference={shownRef}
        damage={damage}
        patches={patches}
        mineEnd={mineInRange.duration}
        refEnd={compareEnd}
        abilityName={abilityName}
        mineToRef={alignment.mineToRef}
        onJump={jumpTo}
        average={average}
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
      {notice}
      {!partial && (
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
      )}
      {!partial && alignment.anchors.length < MIN_ANCHORS && <p className="error">對齊錨點過少，時間軸對齊結果可能不準確。</p>}
      {!job && <p className="hint">此職業尚未有專屬規則，技能不區分 GCD／oGCD。</p>}
      {adviceSection}
      {/* 建議與站位之間的詳細區塊：有 Boss 機制差異時分頁，只有我的日誌（沒有機制差異）時直接列出 */}
      {partial ? (
        <div data-detail="rotation">{rotationSection}</div>
      ) : (
        <Tabs
          className="detail-tabs"
          label="比較結果"
          selected={detail}
          onSelect={setDetail}
          keepMounted
          tabs={[
            { key: 'rotation', label: '輸出循環', content: <div data-detail="rotation">{rotationSection}</div> },
            { key: 'mechanics', label: 'Boss 機制', content: <div data-detail="mechanics">{mechanicsSection}</div> },
          ]}
        />
      )}
      {/* 站位與當下狀態、時間軸一直顯示：配合播放與跳到時間點，兩者同時反映目前的時間 */}
      <h3>站位與當下狀態</h3>
      <Positions
        solo={partial}
        abilityName={abilityName}
        track={positions.track}
        divergences={positions.divergences}
        mineSamples={positions.mineSamples}
        refSamples={partial ? [] : refInRange.playerPositions}
        bossSamples={refInRange.bossPositions}
        mineBossSamples={positions.mineBossSamples}
        mineAlignedSamples={positions.mineAlignedSamples}
        names={{ mine: mine.selection.player.name, ref: reference.selection.player.name }}
        threshold={DIVERGENCE_YALM}
        duration={compareEnd}
        cursor={cursor}
        onSeek={setCursor}
        onJump={jumpTo}
        isFocused={isFocused}
        refToMine={alignment.refToMine}
        status={
          <StatusPanel
            mine={mine}
            reference={average ? null : shownRef}
            cursor={cursor}
            refToMine={alignment.refToMine}
            isFocused={isFocused}
            control={control}
            namedStatus={namedStatus}
            abilities={abilities}
            abilityName={abilityName}
            isGcd={isGcd}
          />
        }
      />
      <h3>時間軸</h3>
      <Timeline
        mine={mine}
        reference={shownRef}
        alignment={alignment}
        abilities={abilities}
        job={job}
        highlights={timelineHighlights}
        windows={timelineWindows}
        weaveMarks={weaveMarks}
        dotMarks={dotMarks}
        isFocused={isFocused}
        pushes={pushes}
        focus={focus}
        cursor={cursor}
        follow={playing}
        onSeek={setCursor}
        compareEnd={solo ? undefined : compareEnd}
        averaged={!!average}
        raidBuffs={mine.raidBuffs}
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
    </RefLabelContext.Provider>
  )
}

/**
 * 比較結果（同一頁漸進顯示）：我的日誌載入後先顯示只用我的日誌能做的分析，參考日誌載入後補上比較。
 * 參考日誌與我的不能比較（不同 Boss／職業）時仍顯示我的分析，並說明原因。
 */
export function Comparison({
  mine,
  reference,
  average = null,
  onAverageInfo,
  sameAsMine = false,
}: {
  mine: Selection
  reference: Selection | null
  /** 參考日誌選了與我同一場同一位（reference 為 null）：說明為何只有我的分析 */
  sameAsMine?: boolean
  /** 參考改用前輩平均（PR 區間）；此時 reference 不用 */
  average?: AverageTier | null
  /** 前輩平均的樣本資訊（樣本清單等，顯示在參考欄位的 PR 區間下方）；還沒有時為 null */
  onAverageInfo?: (info: AverageInfo | null) => void
}) {
  const problem = reference && !average ? incompatibility(mine, reference) : null
  const mineResult = useSide(mine)
  const refResult = useSide(problem || average ? null : reference)
  // 事件只依選擇的 ID 載入一次；顯示用的名稱（Boss 繁中名稱可能晚到）取目前的選擇
  const mineSide = useMemo(() => mineResult?.side && { ...mineResult.side, selection: mine }, [mineResult, mine])
  const refSide = useMemo(
    () => (reference && refResult?.side ? { ...refResult.side, selection: reference } : null),
    [refResult, reference],
  )
  const averageState = useAverageReference(mineSide ?? undefined, average)
  const averageInfo = average && averageState?.status === 'ready' && averageState.side ? averageState.info : null
  useEffect(() => {
    onAverageInfo?.(averageInfo)
  }, [averageInfo, onAverageInfo])
  if (!mineResult) return <p>載入戰鬥事件中…</p>
  if (mineResult.error || !mineSide) return <p className="error">{mineResult.error}</p>
  if (average) {
    const ready = averageState?.status === 'ready' ? averageState : null
    const averageNotice =
      averageState === null || averageState.status === 'loading' ? (
        <p className="hint">載入前輩樣本中…</p>
      ) : averageState.status === 'error' ? (
        <p className="error">前輩樣本載入失敗：{averageState.message}</p>
      ) : !averageState.side ? (
        <p className="hint">這個區間還沒有可用的前輩樣本（樣本仍在整理中），請換其他區間或貼參考日誌。</p>
      ) : averageState.info.used < FEW_SAMPLES ? (
        <p className="hint">樣本只有 {averageState.info.used} 筆，結果接近單一前輩，僅供參考。</p>
      ) : null
    return (
      <Loaded
        key={`average-${average}-${ready?.side ? "ready" : "waiting"}`}
        mine={mineSide}
        reference={ready?.side ?? null}
        average={ready?.side ? ready.info : undefined}
        notice={averageNotice}
      />
    )
  }
  const notice = problem ? (
    <p className="error">{problem}</p>
  ) : sameAsMine ? (
    <p className="error">參考日誌與我的日誌是同一場同一位玩家，只顯示我的分析；請改貼前輩的日誌。</p>
  ) : !reference ? (
    <p className="hint">選擇參考日誌後可比較時間軸、站位、機制與技能時機。</p>
  ) : !refResult ? (
    <p className="hint">載入參考日誌中…</p>
  ) : refResult.error ? (
    <p className="error">參考日誌載入失敗：{refResult.error}</p>
  ) : null
  return <Loaded key={refSide ? 'compare' : 'solo'} mine={mineSide} reference={refSide} notice={notice} />
}
