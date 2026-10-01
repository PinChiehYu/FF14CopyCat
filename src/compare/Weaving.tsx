import type { BadWeave } from '../analysis/weaving'
import { formatFightTime } from '../analysis/timeline'
import { abilityIconUrl } from '../fflogs/report'
import type { Ability } from '../fflogs/types'
import { HelpTip } from './HelpTip'

const seconds = (ms: number) => (ms / 1000).toFixed(1)
const total = (list: BadWeave[]) => list.reduce((sum, w) => sum + w.delayMs, 0)

const WEAVING_HELP = [
  '兩個 GCD 之間穿插的能力技比能放進去的多，下一個 GCD 因此延後（移植自 xivanalysis 的 Weaving）。',
  '可穿插的數量依前一個 GCD 的實際詠唱時間：瞬發 2 個、詠唱 1 秒以上 1 個、2.5 秒以上 0 個；復唱短於 1.8 秒再少 1 個。',
  '只有兩個 GCD 的間隔超過前一個 GCD 的復唱（依你的技能速度）才算；Boss 無法選中、死亡的那一段與開打前不算。',
  '職業例外：武僧一律 2 個（六合星導腳後 4 個）、龍騎士有星天衝時 1 個、毒蛇劍士祖靈之蛇後多 1 個、繪靈法師長詠唱技能依詠唱與復唱計算。',
].join('\n')

/** 穿插過多：兩邊的次數與 GCD 共延後的時間，列出我的每一次（點擊跳轉）。我沒有穿插過多時不顯示這一區（Comparison.tsx）。 */
export function Weaving({
  weaving,
  abilities,
  abilityName,
  mineToRef,
  onJump,
}: {
  weaving: { mine: BadWeave[]; ref: BadWeave[] | null }
  abilities: Map<number, Ability>
  abilityName: (id: number) => string
  mineToRef: (t: number) => number
  onJump: (t: number) => void
}) {
  const { mine, ref } = weaving
  return (
    <>
      <h3>
        穿插過多
        <HelpTip text={WEAVING_HELP} />
      </h3>
      <p>
        {`${mine.length} 次，GCD 共延後 ${seconds(total(mine))} 秒。`}
        {ref && <span className="hint-inline">{`　參考 ${ref.length} 次${ref.length > 0 ? `，共 ${seconds(total(ref))} 秒` : ''}`}</span>}
      </p>
      <ul className="lost-list weave-list">
        {mine.map((w) => (
          <li key={w.start} className={w.delayMs >= 1000 ? 'many' : undefined}>
            <button type="button" onClick={() => onJump(mineToRef(w.start))}>
              {formatFightTime(w.start)}
            </button>
            <span className="weave-icons" aria-label={w.weaves.map((a) => abilityName(a.abilityId)).join('、')}>
              {w.weaves.map((a, i) => {
                const ability = abilities.get(a.abilityId)
                return ability ? (
                  <img key={i} className="usage-icon" src={abilityIconUrl(ability.icon)} alt="" title={abilityName(a.abilityId)} />
                ) : (
                  <span key={i}>{abilityName(a.abilityId)}</span>
                )
              })}
            </span>
            <span>
              {w.weaves.length} 個（可 {Math.max(0, w.allowed)}）
            </span>
            <span>
              GCD 晚 <strong>{seconds(w.delayMs)}</strong> 秒
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}
