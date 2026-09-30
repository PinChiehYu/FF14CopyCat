import type { Advice } from '../analysis/advice'
import { HelpTip } from './HelpTip'

const HELP = [
  '從下方「建議」中依優先程度挑出最該改的幾件事，同一類（例如冷卻技、站位）最多一項。',
  '只列「優先」與「建議」等級；完整說明與其他建議見下方「建議」。',
].join('\n')

/** 比較結果最上方的重點摘要：每項一行標題與「查看」。 */
export function KeyTakeaways({ items, onJump }: { items: Advice[]; onJump: (t: number) => void }) {
  return (
    <div className="key-takeaways">
      <h3>
        重點
        <HelpTip text={HELP} />
      </h3>
      {items.length === 0 ? (
        <p className="hint">沒有明顯需要改進的地方。</p>
      ) : (
        <ol>
          {items.map((a, i) => (
            <li key={i} className={a.severity}>
              <span className="key-takeaway-index">{i + 1}</span>
              <span className="key-takeaway-title">{a.title}</span>
              {a.at !== undefined && (
                <button type="button" onClick={() => onJump(a.at!)}>
                  查看
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
