import { useMemo } from 'react'
import { ACTIVE_WINDOW_MS, LOOKAROUND_MS, RAID_BUFF_NAMES, raidBuffAction, type BurstAlignment } from '../analysis/raidBuffs'
import { formatFightTime } from '../analysis/timeline'
import { abilityIconUrl } from '../fflogs/report'
import type { Ability } from '../fflogs/types'
import { HelpTip } from './HelpTip'

/**
 * 爆發與團隊 Buff 的對齊（只看我的日誌）：每波爆發（冷卻 60 秒以上的輸出技能、強化藥）使用時身上有幾個團隊 Buff，
 * 與前後 20 秒內最多同時有幾個比較。點時間跳到時間軸。
 */
export function RaidBuffAlignment({
  bursts,
  raidBuffName,
  abilities,
  abilityName,
  mineToRef,
  onJump,
}: {
  /** 我的爆發（我的時間） */
  bursts: BurstAlignment[]
  /** 團隊 Buff 的英文名稱 → 顯示名稱（繁中） */
  raidBuffName: (name: string) => string
  abilities: Map<number, Ability>
  abilityName: (id: number) => string
  mineToRef: (t: number) => number
  onJump: (t: number) => void
}) {
  const buffAction = useMemo(() => raidBuffAction(abilities), [abilities])
  const rated = bursts.filter((b) => b.aligned !== null)
  const aligned = rated.filter((b) => b.aligned).length
  const seconds = (ms: number) => (Math.abs(ms) / 1000).toFixed(1)
  return (
    <>
      <h3>
        爆發與團隊 Buff
        <HelpTip
          text={[
            '爆發：冷卻 60 秒以上的輸出技能與強化藥的每次使用（一個 GCD 內連續按下的算同一波）。',
            '團隊 Buff：隊友給的增傷（戰鬥連禱、占卜、技巧舞步結束、義結金蘭、灼熱之光、神秘環、鼓勵、光明神的最終樂章、戰鬥之聲、星空構想），以及施加在敵人身上的連環計、介毒之術。',
            `團隊 Buff 欄為隊友施放的技能圖示：照常的是「當時」有的（使用後 ${ACTIVE_WINDOW_MS / 1000} 秒內同時最多的那一刻），變淡的是前後 ${LOOKAROUND_MS / 1000} 秒內有、但當時沒有的（這次本來可以對上的）。當時有的達到全部圖示的一半、或團隊 Buff 在使用後 ${ACTIVE_WINDOW_MS / 1000} 秒內開始（提早先開）就算對上；附近沒有團隊 Buff 的（例如 60 秒爆發的職業在團隊 Buff 120 秒一輪之間的那次）不評、不列出。`,
            '只看你自己的日誌：隊伍實際給了哪些團隊 Buff。時間為你的戰鬥時間，點擊跳到時間軸。',
          ].join('\n')}
        />
      </h3>
      {rated.length === 0 ? (
        <p className="hint">這場爆發時附近都沒有團隊 Buff（隊伍中沒有給團隊 Buff 的職業，或都不在身上）。</p>
      ) : (
        <>
          <p className="hint">
            對上 <strong>{aligned}</strong>／{rated.length} 次
          </p>
          <table className="summary-table burst-table">
            <thead>
              <tr>
                <th>時間</th>
                <th>爆發</th>
                <th>團隊 Buff</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rated.map((b) => (
                <tr key={b.t}>
                  <td>
                    <button
                      type="button"
                      // 與技能窗口相同的時間標籤：綠＝對上、紅＝沒對上
                      className={`window-chip ${b.aligned ? 'ok' : 'bad'}`}
                      onClick={() => onJump(mineToRef(b.t))}
                    >
                      {formatFightTime(b.t).replace(/\.\d$/, '')}
                    </button>
                  </td>
                  <td className="burst-abilities" title={b.abilityIds.map(abilityName).join('、')}>
                    {b.abilityIds.map((id) => {
                      const ability = abilities.get(id)
                      return ability ? (
                        <img key={id} className="usage-icon" src={abilityIconUrl(ability.icon)} alt={ability.name} loading="lazy" />
                      ) : (
                        <span key={id}>{abilityName(id)}</span>
                      )
                    })}
                  </td>
                  <td
                    title={[
                      b.activeNames.length > 0 ? `當時：${b.activeNames.map(raidBuffName).join('、')}` : '當時沒有團隊 Buff',
                      b.missedNames.length > 0 && `沒對上：${b.missedNames.map(raidBuffName).join('、')}`,
                    ]
                      .filter(Boolean)
                      .join('\n')}
                  >
                    {/* 團隊 Buff 的技能圖示（每列同一順序）：當時有的照常、附近有但沒對上的變淡；找不到技能時以圓點表示 */}
                    <span className="raid-icons" aria-hidden>
                      {[...b.activeNames.map((n) => [n, true] as const), ...b.missedNames.map((n) => [n, false] as const)]
                        .sort(([a], [c]) => RAID_BUFF_NAMES.indexOf(a) - RAID_BUFF_NAMES.indexOf(c))
                        .map(([n, on]) => {
                          const ability = buffAction(n)
                          return ability ? (
                            <img
                              key={n}
                              className={on ? 'usage-icon raid-icon' : 'usage-icon raid-icon off'}
                              src={abilityIconUrl(ability.icon)}
                              alt=""
                              loading="lazy"
                            />
                          ) : (
                            <span key={n} className={on ? 'raid-dot on' : 'raid-dot'} />
                          )
                        })}
                    </span>
                  </td>
                  <td className="burst-result">
                    {b.offsetMs === null ? '✓' : `${b.offsetMs > 0 ? '晚' : '早'} ${seconds(b.offsetMs)} 秒${b.aligned ? '' : ' ✗'}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  )
}
