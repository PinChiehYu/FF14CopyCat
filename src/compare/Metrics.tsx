import type { ReactNode } from 'react'
import { LOST_GCD_SECTION } from '../analysis/advice'
import { controlNames } from '../analysis/control'
import { LATE_LISTED_MS, type CooldownPair, type CooldownUsage } from '../analysis/cooldowns'
import type { AbilityUsage, GcdStats, LostWindow } from '../analysis/metrics'
import { formatFightTime } from '../analysis/timeline'
import { abilityIconUrl } from '../fflogs/report'
import type { Ability } from '../fflogs/types'
import type { JobModule } from '../jobs'
import type { AbilityCategory } from '../jobs/roleActions'
import { groupUsage } from './usageGroups'
import { Tabs } from '../ui/Tabs'
import { HelpTip } from './HelpTip'
import { isRangedFiller } from '../jobs/rangedFillers'

const seconds = (ms: number, digits = 1) => (ms / 1000).toFixed(digits)

function signed(value: number, digits = 1): string {
  const text = value.toFixed(digits)
  return value > 0 ? `+${text}` : text
}

function GcdSection({
  mine,
  reference,
  lost,
  onFocus,
  abilityName,
}: {
  mine: GcdStats
  /** 還沒有參考日誌時為 null：只列我的數字，停手時段改依自己的 GCD 間隔估計（見 idleWindows） */
  reference: GcdStats | null
  lost: LostWindow[]
  onFocus: (refTime: number) => void
  abilityName?: (id: number) => string
}) {
  const controlled = lost.filter((w) => w.control)
  const lostTotal = lost.reduce((sum, w) => sum + w.refGcds, 0)
  const slower = reference && mine.gcdMs !== null && reference.gcdMs !== null ? mine.gcdMs - reference.gcdMs : 0

  return (
    <>
      <h3>
        GCD
        <HelpTip
          text={`GCD 間隔取開始施放時間的中位數；空檔含 Boss 無法攻擊的時間${reference ? '，與參考的差距才有意義' : ''}。`}
        />
      </h3>
      <table className="metrics-table">
        <thead>
          <tr>
            <th />
            <th className="mine">我</th>
            {reference && <th className="ref">參考</th>}
            {reference && <th>差距</th>}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>GCD 數</th>
            <td>{mine.count}</td>
            {reference && <td>{reference.count}</td>}
            {reference && <td>{signed(mine.count - reference.count, 0)}</td>}
          </tr>
          <tr>
            <th>GCD 間隔</th>
            <td>{mine.gcdMs !== null ? `${seconds(mine.gcdMs, 3)} 秒` : '—'}</td>
            {reference && <td>{reference.gcdMs !== null ? `${seconds(reference.gcdMs, 3)} 秒` : '—'}</td>}
            {reference && <td>{slower ? `${signed(slower, 0)} 毫秒` : '—'}</td>}
          </tr>
          <tr>
            <th>空檔總計</th>
            <td>{seconds(mine.idleMs)} 秒</td>
            {reference && <td>{seconds(reference.idleMs)} 秒</td>}
            {reference && <td>{signed((mine.idleMs - reference.idleMs) / 1000)} 秒</td>}
          </tr>
        </tbody>
      </table>
      {slower > 10 && <p className="hint">你的 GCD 比參考慢 {slower.toFixed(0)} 毫秒，可能是技能速度或加速效果的差異。</p>}

      {/* 停手建議的「查看」捲到這裡（LOST_GCD_SECTION） */}
      <h3 id={LOST_GCD_SECTION}>
        {reference ? '少打 GCD 的時段' : '停手時段'}
        <HelpTip
          text={[
            reference
              ? '你的 GCD 間隔超過 1.5 個 GCD（且至少多 1 秒）、參考在同一段（依 Boss 機制對齊）仍施放 GCD 的時段；「參考打 N 個 GCD」即你少打的數量。雙方都停手的時段（Boss 無法攻擊等）不列入。'
              : 'GCD 間隔超過 1.5 個 GCD（且至少多 1 秒）的時段；「約少 N 個 GCD」依你的 GCD 間隔估計，Boss 無法選中與死亡的時間已扣除。',
            '控場：你身上有 Boss 施加、期間無法施放的效果，停手是機制造成（滑鼠停在標籤上可看效果名稱）。',
          ].join('\n')}
        />
      </h3>
      {lost.length === 0 ? (
        <p className="hint">{reference ? '沒有「你停手但參考仍在施放」的時段。' : '沒有停手的時段。'}</p>
      ) : (
        <>
          <p>
            {reference
              ? `共 ${lost.length} 段，參考在這些時段多打了 ${lostTotal} 個 GCD。`
              : `共 ${lost.length} 段，約少打 ${lostTotal} 個 GCD。`}
            {controlled.length > 0 && `其中 ${controlled.length} 段你被 Boss 控場，停手是機制造成。`}
          </p>
          {/* 每段一列、欄位對齊（時間｜停手秒數｜參考同段的 GCD 數或估計少打的 GCD 數），手機上也不換行 */}
          <ul className="lost-list">
            {lost.map((w) => (
              <li key={w.mineStart} className={w.control ? 'controlled' : w.refGcds >= 3 ? 'many' : undefined}>
                <button type="button" onClick={() => onFocus(w.refStart)} title="跳到這段">
                  {formatFightTime(w.mineStart)}–{formatFightTime(w.mineEnd)}
                </button>
                <span>停手 {seconds(w.mineEnd - w.mineStart)} 秒</span>
                {reference ? (
                  <span>
                    參考打 <strong>{w.refGcds}</strong> 個 GCD
                  </span>
                ) : (
                  <span>
                    約少 <strong>{w.refGcds}</strong> 個 GCD
                  </span>
                )}
                {/* 滑鼠提示只放控場效果的名稱；「控場」的意義在標題的「?」 */}
                {w.control && (
                  <span className="tag control" title={controlNames(w.control, abilityName ?? ((id) => `#${id}`))}>
                    控場
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

export function Metrics({
  gcd,
  usage,
  abilities,
  job,
  category,
  lost,
  onFocus,
  cooldowns = [],
  mineToRef,
  abilityName,
  solo = false,
  afterGcd,
}: {
  /** 接在 GCD 與停手時段之後的區塊（止損技） */
  afterGcd?: ReactNode
  /** 沒有職業模組時為 null；還沒有參考日誌時 ref 為 null */
  gcd: { mine: GcdStats; ref: GcdStats | null } | null
  /** 還沒有參考日誌：只列我的數字 */
  solo?: boolean
  usage: AbilityUsage[]
  /** 冷卻技是否好了就用（兩邊依各自版本的規則；該版本沒有這個技能組時為 null） */
  cooldowns?: CooldownPair[]
  mineToRef?: (t: number) => number
  /** 報告技能清單沒有的技能（兩邊都沒用過的冷卻技）也能顯示名稱 */
  abilityName?: (id: number) => string
  abilities: Map<number, Ability>
  job: JobModule | undefined
  category: (abilityId: number) => AbilityCategory
  lost: LostWindow[]
  onFocus: (refTime: number) => void
}) {
  const groups = groupUsage(usage, category, job?.isGcd)
  const row = (u: AbilityUsage) => {
    const ability = abilities.get(u.abilityId)
    const timing =
      u.avgDelayMs === null
        ? '—'
        : Math.abs(u.avgDelayMs) < 500
          ? '相同'
          : `${u.avgDelayMs > 0 ? '晚' : '早'} ${seconds(Math.abs(u.avgDelayMs))} 秒`
    const diff = u.mine - u.ref
    return (
      <li key={u.abilityId} className={`usage-card${solo ? '' : diff < 0 ? ' fewer' : diff > 0 ? ' more' : ''}`}>
        <div className="usage-name" title={ability?.englishName}>
          {ability && (
            <img className={`usage-icon${isRangedFiller(u.abilityId) ? ' filler' : ''}`} src={abilityIconUrl(ability.icon)} alt="" loading="lazy" />
          )}
          <span>{ability?.name ?? `#${u.abilityId}`}</span>
          {isRangedFiller(u.abilityId) && <span className="tag filler">止損</span>}
        </div>
        <dl className="usage-stats">
          <div>
            <dt className="mine">我</dt>
            <dd>{u.mine}</dd>
          </div>
          {!solo && (
            <>
              <div>
                <dt className="ref">參考</dt>
                <dd>{u.ref}</dd>
              </div>
              <div>
                <dt>差距</dt>
                <dd className="usage-diff">{diff === 0 ? '—' : signed(diff, 0)}</dd>
              </div>
              <div>
                <dt>平均時機</dt>
                <dd>{timing}</dd>
              </div>
            </>
          )}
        </dl>
      </li>
    )
  }
  // 冷卻技：可用次數與晚用的次數（xivanalysis 的 CooldownDowntime），放在第一個分頁
  const cooldownCard = ({ mine, ref }: CooldownPair) => {
    const group = (mine ?? ref)!.group
    const ability = abilities.get(group.ids[0])
    const lost = (c: CooldownUsage | null) => (c ? Math.max(0, c.max - c.uses) : 0)
    const lateList = (mine?.late ?? []).filter((l) => l.lateMs >= LATE_LISTED_MS)
    const title = [
      ability?.englishName,
      `理論最多可用次數：依冷卻時間、每次冷卻好就用計算（Boss 無法選取的時間不算）`,
      ...lateList.map((l) => `${formatFightTime(mineToRef ? mineToRef(l.t) : l.t)} 晚了 ${seconds(l.lateMs)} 秒`),
    ]
      .filter(Boolean)
      .join('\n')
    return (
      <li key={group.key} className={`usage-card${(solo ? lost(mine) > 0 : lost(mine) > lost(ref)) ? ' fewer' : ''}`} title={title}>
        <div className="usage-name">
          {ability && <img className="usage-icon" src={abilityIconUrl(ability.icon)} alt="" loading="lazy" />}
          <span>{ability?.name ?? abilityName?.(group.ids[0]) ?? `#${group.ids[0]}`}</span>
        </div>
        <dl className="usage-stats">
          <div>
            <dt className="mine">我</dt>
            <dd>{mine ? `${mine.uses}／${mine.max}` : '—'}</dd>
          </div>
          {!solo && (
            <div>
              <dt className="ref">參考</dt>
              <dd>{ref ? `${ref.uses}／${ref.max}` : '—'}</dd>
            </div>
          )}
          <div>
            <dt>晚用</dt>
            <dd>{mine ? (lateList.length === 0 ? '—' : `${lateList.length} 次`) : '—'}</dd>
          </div>
          <div>
            <dt>最晚</dt>
            <dd>{lateList.length === 0 ? '—' : `${seconds(Math.max(...lateList.map((l) => l.lateMs)))} 秒`}</dd>
          </div>
        </dl>
      </li>
    )
  }
  const cooldownTab =
    cooldowns.length === 0
      ? []
      : [
          {
            key: 'cooldowns',
            label: '冷卻技',
            count: cooldowns.length,
            variant: 'cooldowns',
            content: <ul className="usage-grid">{cooldowns.map(cooldownCard)}</ul>,
          },
        ]
  // 依分類分頁，每頁以卡片橫向排列
  const tabs = [
    ...cooldownTab,
    ...groups.map((group) => ({
      key: group.key,
      label: group.label,
      count: group.rows.length,
      variant: group.key,
      content: <ul className="usage-grid">{group.rows.map(row)}</ul>,
    })),
  ]
  return (
    <section className="metrics">
      {gcd ? (
        <GcdSection mine={gcd.mine} reference={gcd.ref} lost={lost} onFocus={onFocus} abilityName={abilityName} />
      ) : (
        <p className="hint">此職業尚未有專屬規則，無法計算 GCD 指標。</p>
      )}
      {afterGcd}

      <h3>
        技能使用次數
        <HelpTip
          text={[
            `冷卻技：「用了／最多可用」依冷卻時間與每次冷卻好就用計算（移植自 xivanalysis，Boss 無法選取的時間不算）；晚用為冷卻好後晚了 ${LATE_LISTED_MS / 1000} 秒以上才用。`,
            !solo &&
              '平均時機：把你（依 Boss 機制對齊後）與參考的每次使用依序配對（相距 30 秒以內才算同一次），計算你平均早或晚多少；使用 30 次以上的技能（連擊等）不計算。',
            '普通攻擊不顯示在時間軸，次數明顯較少通常代表離 Boss 太遠或停手較久。',
            '「止損」：近戰與坦克離開 Boss 時用的遠程 GCD（例如投盾、飛刀），威力低；用得多代表離 Boss 太遠或走位不順。',
          ]
            .filter(Boolean)
            .join('\n')}
        />
      </h3>
      <Tabs tabs={tabs} label="技能分類" />
    </section>
  )
}
