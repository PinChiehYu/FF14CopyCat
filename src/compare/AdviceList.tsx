import type { Advice, Severity } from '../analysis/advice'

const GROUPS: { severity: Severity; label: string; open: boolean }[] = [
  // 只有「優先」預設展開，其餘收合以免頁面過長
  { severity: 'high', label: '優先', open: true },
  { severity: 'medium', label: '建議', open: false },
  { severity: 'low', label: '參考', open: false },
]

function AdviceItem({ advice, onJump }: { advice: Advice; onJump: (t: number) => void }) {
  return (
    <li className={`advice ${advice.severity}`}>
      <div>
        <strong>{advice.title}</strong>
        <p>{advice.detail}</p>
      </div>
      {advice.at !== undefined && (
        <button type="button" onClick={() => onJump(advice.at!)}>
          查看
        </button>
      )}
    </li>
  )
}

export function AdviceList({ advice, onJump }: { advice: Advice[]; onJump: (t: number) => void }) {
  if (advice.length === 0) {
    return <p className="hint">沒有明顯需要改進的地方，你的表現與參考玩家相近。</p>
  }
  return (
    <div className="advice-groups">
      {GROUPS.map(({ severity, label, open }) => {
        const items = advice.filter((a) => a.severity === severity)
        if (items.length === 0) return null
        return (
          <details key={severity} className={`advice-group ${severity}`} open={open}>
            <summary>
              <span className="severity">{label}</span>
              <span className="count">{items.length} 則</span>
            </summary>
            <ol className="advice-list">
              {items.map((a, i) => (
                <AdviceItem key={i} advice={a} onJump={onJump} />
              ))}
            </ol>
          </details>
        )
      })}
    </div>
  )
}
