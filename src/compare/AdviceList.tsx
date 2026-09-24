import type { Advice, Severity } from '../analysis/advice'

const LABELS: Record<Severity, string> = { high: '優先', medium: '建議', low: '參考' }

export function AdviceList({ advice, onJump }: { advice: Advice[]; onJump: (t: number) => void }) {
  if (advice.length === 0) {
    return <p className="hint">沒有明顯需要改進的地方，你的表現與參考玩家相近。</p>
  }
  return (
    <ol className="advice-list">
      {advice.map((a, i) => (
        <li key={i} className={`advice ${a.severity}`}>
          <span className="severity">{LABELS[a.severity]}</span>
          <div>
            <strong>{a.title}</strong>
            <p>{a.detail}</p>
          </div>
          {a.at !== undefined && (
            <button type="button" onClick={() => onJump(a.at!)}>
              查看
            </button>
          )}
        </li>
      ))}
    </ol>
  )
}
