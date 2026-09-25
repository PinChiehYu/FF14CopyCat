import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export interface DropdownOption<T> {
  value: T
  /** 選單與按鈕上顯示的內容 */
  content: ReactNode
  /** 滑鼠停留時的說明 */
  title?: string
}

/** 取代原生 <select> 的下拉選單，選項可以放徽章等排版；支援鍵盤上下選擇、Enter 確認、Esc 關閉。 */
export function Dropdown<T>({
  label,
  options,
  value,
  placeholder = '請選擇',
  onChange,
}: {
  label: string
  options: DropdownOption<T>[]
  value: T | null
  placeholder?: string
  onChange: (value: T) => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const id = useId()
  const selectedIndex = options.findIndex((o) => o.value === value)
  const selected = options[selectedIndex]

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const toggle = () => {
    setActive(Math.max(selectedIndex, 0))
    setOpen((o) => !o)
  }
  const choose = (index: number) => {
    onChange(options[index].value)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggle()
      }
      return
    }
    if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, options.length - 1))
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0))
    else if (e.key === 'Home') setActive(0)
    else if (e.key === 'End') setActive(options.length - 1)
    else if (e.key === 'Enter' || e.key === ' ') {
      if (options[active]) choose(active)
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false)
      return
    } else return
    e.preventDefault()
  }

  return (
    <div className="dropdown" ref={root}>
      <span className="dropdown-label" id={`${id}-label`}>
        {label}
      </span>
      <button
        type="button"
        className={`dropdown-button${open ? ' open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${id}-label`}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        title={selected?.title}
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        <span className="dropdown-value">
          {selected ? selected.content : <span className="dropdown-placeholder">{placeholder}</span>}
        </span>
        <span className="dropdown-arrow" aria-hidden="true" />
      </button>
      {open && (
        <ul className="dropdown-list" role="listbox" ref={list} aria-labelledby={`${id}-label`}>
          {options.map((o, i) => (
            <li
              key={i}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === selectedIndex}
              className={`${i === active ? 'active' : ''}${i === selectedIndex ? ' selected' : ''}`}
              title={o.title}
              onMouseEnter={() => setActive(i)}
              // mousedown 會先讓按鈕失焦，改在 click 選擇
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
            >
              {o.content}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
