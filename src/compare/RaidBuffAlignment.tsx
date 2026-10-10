import { useMemo } from 'react'
import { ACTIVE_WINDOW_MS, RAID_BUFF_NAMES, SAME_BURST_MS, raidBuffAction, type BurstAlignment } from '../analysis/raidBuffs'
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
  hasBurstSkills,
  raidBuffName,
  abilities,
  abilityName,
  mineToRef,
  onJump,
}: {
  /** 我的爆發（我的時間） */
  bursts: BurstAlignment[]
  /** 職業有爆發技（jobs/burstRules.ts）；沒有的職業（黑魔、賢者）只說明不評 */
  hasBurstSkills: boolean
  /** 團隊 Buff 的英文名稱 → 顯示名稱（繁中） */
  raidBuffName: (name: string) => string
  abilities: Map<number, Ability>
  abilityName: (id: number) => string
  mineToRef: (t: number) => number
  onJump: (t: number) => void
}) {
  const buffAction = useMemo(() => raidBuffAction(abilities), [abilities])
  // 同名的不同 ID（例如四色技巧舞步結束有兩個 ID，日誌兩個都會記）只列一次
  const uniqueByName = (ids: number[]) => ids.filter((id, i) => ids.findIndex((other) => abilityName(other) === abilityName(id)) === i)
  const rated = bursts.filter((b) => b.aligned !== null)
  const aligned = rated.filter((b) => b.aligned).length
  const seconds = (ms: number) => (Math.abs(ms) / 1000).toFixed(1)
  return (
    <>
      <h3>
        爆發與團隊 Buff
        <HelpTip
          text={[
            `爆發：各職業的爆發技（例如戰逃反應、紅蓮極意、意氣衝天、野火）與強化藥；好了就用的技能、給狀態的準備動作不算。相隔 ${SAME_BURST_MS / 1000} 秒以內連續使用的算同一波；只是給狀態的技能以之後真正的爆發判斷（例如蝰蛇的蛇靈氣看之後的祖靈降臨）。`,
            '團隊 Buff：隊友給的增傷（戰鬥連禱、占卜、技巧舞步結束、義結金蘭、灼熱之光、神秘環、鼓勵、光明神的最終樂章、戰鬥之聲、星空構想），以及施加在敵人身上的連環計、介毒之術；你自己給的不算（一定對得上），只看隊友的。',
            `每張卡片依序為：時間（點擊跳到時間軸）、這波爆發用的技能、團隊 Buff（隊友施放的技能圖示）、早晚與結果。團隊 Buff 圖示：照常的是「當時」有的（這一波期間到最後一個技能後 ${ACTIVE_WINDOW_MS / 1000} 秒內同時最多的那一刻），變淡的是附近有、但當時沒有的（這次本來可以對上的）。當時有的達到全部圖示的一半、或團隊 Buff 在使用後 ${ACTIVE_WINDOW_MS / 1000} 秒內開始（提早先開）就算對上。2 分鐘爆發每次都評（附近＝前後 60 秒）；1 分鐘爆發只評附近（前後 20 秒）有團隊 Buff 的那次，兩輪團隊 Buff 之間的不列出。`,
            '只看你自己的日誌：隊伍實際給了哪些團隊 Buff。時間為你的戰鬥時間。',
          ].join('\n')}
        />
      </h3>
      {!hasBurstSkills ? (
        <p className="hint">這個職業沒有固定對齊團隊 Buff 的爆發技，不評（強化藥的時間依各隊規劃而定）。</p>
      ) : rated.length === 0 ? (
        <p className="hint">這場爆發時附近都沒有團隊 Buff（隊伍中沒有給團隊 Buff 的職業，或都不在身上）。</p>
      ) : (
        <>
          <p className="hint">
            對上 <strong>{aligned}</strong>／{rated.length} 次
          </p>
          {/* 每波一張卡片（時間｜爆發技能｜團隊 Buff｜結果），寬螢幕上多張並排，避免一波一列把頁面拉長 */}
          <ul className="burst-cards">
            {rated.map((b) => (
              <li key={b.t} className={`burst-card ${b.aligned ? 'ok' : 'bad'}`}>
                <button
                  type="button"
                  // 與技能窗口相同的時間標籤：綠＝對上、紅＝沒對上
                  className={`window-chip ${b.aligned ? 'ok' : 'bad'}`}
                  onClick={() => onJump(mineToRef(b.t))}
                >
                  {formatFightTime(b.t).replace(/\.\d$/, '')}
                </button>
                {/* 圖示多時只在中間換行，時間與結果固定在第一行兩端 */}
                <span className="burst-icons">
                  <span className="burst-abilities" title={`爆發：${uniqueByName(b.abilityIds).map(abilityName).join('、')}`}>
                    {uniqueByName(b.abilityIds).map((id) => {
                      const ability = abilities.get(id)
                      return ability ? (
                        <img key={id} className="usage-icon" src={abilityIconUrl(ability.icon)} alt={ability.name} loading="lazy" />
                      ) : (
                        <span key={id}>{abilityName(id)}</span>
                      )
                    })}
                  </span>
                  {/* 團隊 Buff 的技能圖示（每張同一順序）：當時有的照常、附近有但沒對上的變淡；找不到技能時以圓點表示 */}
                  <span
                    className="raid-icons"
                    title={[
                      b.activeNames.length > 0 ? `團隊 Buff 當時：${b.activeNames.map(raidBuffName).join('、')}` : '當時沒有團隊 Buff',
                      b.missedNames.length > 0 && `沒對上：${b.missedNames.map(raidBuffName).join('、')}`,
                    ]
                      .filter(Boolean)
                      .join('\n')}
                  >
                    {[...b.activeNames.map((n) => [n, true] as const), ...b.missedNames.map((n) => [n, false] as const)]
                      .sort(([a], [c]) => RAID_BUFF_NAMES.indexOf(a) - RAID_BUFF_NAMES.indexOf(c))
                      .map(([n, on]) => {
                        const ability = buffAction(n)
                        return ability ? (
                          <img key={n} className={on ? 'usage-icon raid-icon' : 'usage-icon raid-icon off'} src={abilityIconUrl(ability.icon)} alt="" loading="lazy" />
                        ) : (
                          <span key={n} className={on ? 'raid-dot on' : 'raid-dot'} />
                        )
                      })}
                  </span>
                </span>
                <span className="burst-result">
                  {b.offsetMs === null ? '✓' : `${b.offsetMs > 0 ? '晚' : '早'} ${seconds(b.offsetMs)} 秒${b.aligned ? '' : ' ✗'}`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}
