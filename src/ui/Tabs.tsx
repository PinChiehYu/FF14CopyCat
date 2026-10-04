import { useId, useState, type ReactNode } from 'react'

export interface Tab {
  key: string
  label: ReactNode
  /** 標籤旁的數量 */
  count?: number
  /** 額外的 class，用來區分顏色（例如 high / medium） */
  variant?: string
  content: ReactNode
}

/**
 * 分頁：一次只顯示一組內容。支援左右鍵切換。
 * 傳入 selected／onSelect 時由外部控制（例如點「查看」切到時間軸）；keepMounted 時其他分頁只隱藏不卸載，
 * 切換時保留各分頁的狀態（縮放、捲動位置等）。
 */
export function Tabs({
  tabs,
  label,
  selected: controlled,
  onSelect,
  keepMounted = false,
  className,
}: {
  tabs: Tab[]
  label: string
  selected?: string
  onSelect?: (key: string) => void
  keepMounted?: boolean
  className?: string
}) {
  const [own, setOwn] = useState<string | null>(null)
  const selected = controlled ?? own
  const setSelected = (key: string) => {
    setOwn(key)
    onSelect?.(key)
  }
  const id = useId()
  // 分頁內容改變（例如換了比較對象）而原本的分頁不見時，回到第一個
  const current = tabs.find((t) => t.key === selected) ?? tabs[0]
  if (!current) return null

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const next = e.key === 'ArrowRight' ? index + 1 : e.key === 'ArrowLeft' ? index - 1 : null
    if (next === null) return
    e.preventDefault()
    const tab = tabs[(next + tabs.length) % tabs.length]
    setSelected(tab.key)
    document.getElementById(`${id}-tab-${tab.key}`)?.focus()
  }

  return (
    <div className={`tabs${className ? ` ${className}` : ''}`}>
      <div className="tab-list" role="tablist" aria-label={label}>
        {tabs.map((t, i) => {
          const active = t === current
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`${id}-tab-${t.key}`}
              aria-selected={active}
              aria-controls={`${id}-panel`}
              tabIndex={active ? 0 : -1}
              className={`tab ${t.variant ?? ''}${active ? ' active' : ''}`}
              onClick={() => setSelected(t.key)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {t.label}
              {t.count !== undefined && <span className="tab-count">{t.count}</span>}
            </button>
          )
        })}
      </div>
      {keepMounted ? (
        tabs.map((t) => (
          <div
            key={t.key}
            className="tab-panel"
            role="tabpanel"
            id={t === current ? `${id}-panel` : undefined}
            aria-labelledby={`${id}-tab-${t.key}`}
            hidden={t !== current}
          >
            {t.content}
          </div>
        ))
      ) : (
        <div className="tab-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${current.key}`}>
          {current.content}
        </div>
      )}
    </div>
  )
}
