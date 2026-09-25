import type { Advice, Severity } from '../analysis/advice'
import { Tabs } from '../ui/Tabs'

const GROUPS: { severity: Severity; label: string }[] = [
  { severity: 'high', label: '優先' },
  { severity: 'medium', label: '建議' },
  { severity: 'low', label: '參考' },
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
  // 依優先級分頁，預設顯示最高的一級，避免頁面過長
  const tabs = GROUPS.map(({ severity, label }) => ({ severity, label, items: advice.filter((a) => a.severity === severity) }))
    .filter((g) => g.items.length > 0)
    .map(({ severity, label, items }) => ({
      key: severity,
      label,
      count: items.length,
      variant: severity,
      content: (
        <ol className="advice-list">
          {items.map((a, i) => (
            <AdviceItem key={i} advice={a} onJump={onJump} />
          ))}
        </ol>
      ),
    }))
  return <Tabs tabs={tabs} label="建議優先級" />
}
