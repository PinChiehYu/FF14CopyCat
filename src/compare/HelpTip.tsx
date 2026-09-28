import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * 說明文字收在「?」圖示裡：滑鼠停留顯示提示（title），點擊（手機）展開說明框，點其他地方或按 Esc 收起。
 * 用在標題旁或工具列，取代佔整行的說明文字。
 */
export function HelpTip({ text, label = '說明' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)

  // 說明框超出畫面右緣（圖示靠右、手機寬度）時往左移，保留 16px 邊距
  useLayoutEffect(() => {
    const el = bubble.current
    if (!open || !el) return
    el.style.transform = ''
    const overflow = el.getBoundingClientRect().right - (document.documentElement.clientWidth - 16)
    if (overflow > 0) el.style.transform = `translateX(${-overflow}px)`
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <span className="help-tip" ref={root}>
      <button
        type="button"
        className="help-tip-button"
        aria-label={label}
        aria-expanded={open}
        title={open ? undefined : text}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && (
        <span className="help-tip-bubble" role="tooltip" ref={bubble}>
          {text}
        </span>
      )}
    </span>
  )
}
