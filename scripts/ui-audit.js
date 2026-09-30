// 在瀏覽器中檢查比較結果頁的版面（以瀏覽器面板的 javascript_tool 或開發者工具執行整段，回傳 JSON）。
// 桌面與手機（375 px）各跑一次，比較兩者的區塊是否一致。檢查項目：
// - 頁面是否橫向捲動、元素是否超出畫面或被裁切（捲動區內的不算：時間軸、站位差異卡片列）
// - 「?」圖示大小是否一致、錯誤訊息、主要區塊是否都有顯示
;(() => {
  const vw = document.documentElement.clientWidth
  const section = document.querySelector('section.comparison')
  const scrollable = (el) => {
    for (let p = el; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX
      if (o === 'auto' || o === 'scroll') return true
    }
    return false
  }
  const label = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}「${(el.textContent || '').trim().slice(0, 24)}」`
  const visible = (el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed'

  const offscreen = []
  const clipped = []
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.closest('svg') && el.tagName !== 'svg') continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (r.right > vw + 1 && !scrollable(el)) offscreen.push(`${label(el)} 右緣 ${Math.round(r.right)} > ${vw}`)
    const cs = getComputedStyle(el)
    const overflowVisible = cs.overflowX === 'visible'
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && overflowVisible && !scrollable(el) && el.children.length === 0) {
      clipped.push(`${label(el)} 內容 ${el.scrollWidth} > ${el.clientWidth}`)
    }
  }

  const tips = [...document.querySelectorAll('.help-tip-button')].filter(visible).map((b) => {
    const r = b.getBoundingClientRect()
    return `${Math.round(r.width)}x${Math.round(r.height)}`
  })
  const tipSizes = [...new Set(tips)]

  const headings = [...(section?.querySelectorAll('h2, h3') ?? [])].filter(visible).map((h) => h.textContent.replace('?', '').trim())
  const errors = [...document.querySelectorAll('.error')].filter(visible).map((e) => e.textContent.trim().slice(0, 80))

  return JSON.stringify({
    viewport: vw,
    loaded: !!section && !!section.querySelector('.compare-summary'),
    horizontalScroll: document.documentElement.scrollWidth > vw + 1 ? document.documentElement.scrollWidth : false,
    offscreen: offscreen.slice(0, 15),
    clipped: clipped.slice(0, 15),
    helpTipSizes: tipSizes,
    helpTips: tips.length,
    headings,
    errors,
  }, null, 2)
})()
