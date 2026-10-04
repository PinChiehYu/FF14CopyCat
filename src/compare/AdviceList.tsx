import { groupAdvice, type Advice, type AdviceGroup, type Severity } from '../analysis/advice'
import { Tabs } from '../ui/Tabs'

const GROUPS: { severity: Severity; label: string }[] = [
  { severity: 'high', label: '優先' },
  { severity: 'medium', label: '建議' },
  { severity: 'low', label: '參考' },
]

/** 「查看」的動作：跳到時間點，或到頁面上的對應區塊（可能在其他分頁，由比較結果切換分頁後捲動） */
interface Jumps {
  onJump: (t: number) => void
  onSection: (id: string) => void
}

function AdviceItem({ advice, onJump, onSection }: { advice: Advice } & Jumps) {
  return (
    <li className={`advice ${advice.severity}`}>
      {/* 「查看」與標題同一列，說明文字用滿整個寬度 */}
      <div className="advice-head">
        <strong>{advice.title}</strong>
        {advice.section ? (
          // 捲到頁面上的對應區塊（例如停手總結 → 少打 GCD 的時段）
          <button type="button" onClick={() => onSection(advice.section!)}>
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
function Group({ group, onJump, onSection }: { group: AdviceGroup } & Jumps) {
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
          <AdviceItem key={i} advice={a} onJump={onJump} onSection={onSection} />
        ))}
      </ol>
    </li>
  )
}

export function AdviceList({ advice, onJump, onSection }: { advice: Advice[] } & Jumps) {
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
            <Group key={g.key} group={g} onJump={onJump} onSection={onSection} />
          ))}
        </ol>
      ),
    }))
  return <Tabs tabs={tabs} label="建議優先級" />
}
