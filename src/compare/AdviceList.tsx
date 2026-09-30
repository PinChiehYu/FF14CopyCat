import { groupAdvice, type Advice, type AdviceGroup, type Severity } from '../analysis/advice'
import { Tabs } from '../ui/Tabs'

const GROUPS: { severity: Severity; label: string }[] = [
  { severity: 'high', label: '優先' },
  { severity: 'medium', label: '建議' },
  { severity: 'low', label: '參考' },
]

function AdviceItem({ advice, onJump }: { advice: Advice; onJump: (t: number) => void }) {
  return (
    <li className={`advice ${advice.severity}`}>
      {/* 「查看」與標題同一列，說明文字用滿整個寬度 */}
      <div className="advice-head">
        <strong>{advice.title}</strong>
        {advice.section ? (
          // 捲到頁面上的對應區塊（例如停手總結 → 少打 GCD 的時段）
          <button type="button" onClick={() => document.getElementById(advice.section!)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            查看
          </button>
        ) : (
          advice.at !== undefined && (
            <button type="button" onClick={() => onJump(advice.at!)}>
              查看
            </button>
          )
        )}
      </div>
      <p>{advice.detail}</p>
    </li>
  )
}

/** 一組相關的建議：類別名稱（多於一則時附則數）＋各則 */
function Group({ group, onJump }: { group: AdviceGroup; onJump: (t: number) => void }) {
  return (
    <li className="advice-group">
      {group.label && (
        <div className="advice-group-label">
          {group.label}
          {group.items.length > 1 && <span className="advice-group-count">{group.items.length}</span>}
        </div>
      )}
      <ol className="advice-list">
        {group.items.map((a, i) => (
          <AdviceItem key={i} advice={a} onJump={onJump} />
        ))}
      </ol>
    </li>
  )
}

export function AdviceList({ advice, onJump }: { advice: Advice[]; onJump: (t: number) => void }) {
  if (advice.length === 0) {
    return <p className="hint">沒有明顯需要改進的地方，你的表現與參考玩家相近。</p>
  }
  // 依各則的等級分頁（預設顯示最高的一級，避免頁面過長）；同一分頁內相關的建議成組一起列出，組依重要性排序
  const tabs = GROUPS.map(({ severity, label }) => ({ severity, label, groups: groupAdvice(advice.filter((a) => a.severity === severity)) }))
    .filter((t) => t.groups.length > 0)
    .map(({ severity, label, groups: inTab }) => ({
      key: severity,
      label,
      count: inTab.reduce((sum, g) => sum + g.items.length, 0),
      variant: severity,
      content: (
        <ol className="advice-groups">
          {inTab.map((g) => (
            <Group key={g.key} group={g} onJump={onJump} />
          ))}
        </ol>
      ),
    }))
  return <Tabs tabs={tabs} label="建議優先級" />
}
