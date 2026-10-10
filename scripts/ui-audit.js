// 在瀏覽器中檢查比較結果頁的版面（以瀏覽器面板的 javascript_tool 或開發者工具執行整段，回傳 JSON）。
// 桌面與手機（375 px）各跑一次，比較兩者的區塊是否一致。檢查項目：
// - 頁面是否橫向捲動、元素是否超出畫面或被裁切（捲動區內的不算：時間軸、站位差異卡片列）
// - 表格儲存格內的內容超出儲存格、蓋到隔壁欄（overflowCell）
// - 區塊內的橫向捲動（innerScroll）：時間軸與站位差異卡片列本來就會捲動，其他區塊（例如 .metrics 的保險捲動）出現捲動代表內容超出欄寬
// - 短文字是否被拆成兩行（split）
// - 「?」圖示大小是否一致、錯誤訊息、主要區塊是否都有顯示
// 比較結果下半部的分頁（輸出循環／機制與站位／時間軸）逐一切換檢查，結束後切回原本的分頁（非同步：結果是 Promise）。
;(async () => {
  const vw = document.documentElement.clientWidth
  // 瀏覽器面板剛開啟或隱藏時寬度可能是 0，結果全是誤報：先以 resize_window 設定固定尺寸（例如 1280×900）再跑
  if (vw < 300) return JSON.stringify({ viewport: vw, invalid: '視窗寬度過小，請先設定固定尺寸再重新載入' })
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

  // 設計上就會橫向捲動的區域
  const INTENDED_SCROLL = ['.timeline-scroll', '.divergence-cards']
  const offscreen = new Set()
  const innerScroll = new Set()
  const clipped = new Set()
  const overflowCell = new Set()
  const split = new Set()
  const tips = []
  const headings = []
  const errors = new Set()
  const check = () => {
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.closest('svg') && el.tagName !== 'svg') continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (r.right > vw + 1 && !scrollable(el)) offscreen.add(`${label(el)} 右緣 ${Math.round(r.right)} > ${vw}`)
    const cs = getComputedStyle(el)
    const overflowVisible = cs.overflowX === 'visible'
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && !INTENDED_SCROLL.some((s) => el.matches(s))) {
      innerScroll.add(`${label(el)} 內容 ${el.scrollWidth} > ${el.clientWidth}`)
    }
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && overflowVisible && !scrollable(el) && el.children.length === 0) {
      clipped.add(`${label(el)} 內容 ${el.scrollWidth} > ${el.clientWidth}`)
    }
    // 表格儲存格內不換行的文字（行內元素量不到 scrollWidth）超出儲存格，蓋到隔壁欄
    const cell = el.parentElement?.closest('td, th')
    if (cell && !el.matches('td, th') && !scrollable(el)) {
      const c = cell.getBoundingClientRect()
      if (r.right > c.right + 1 || r.left < c.left - 1) overflowCell.add(`${label(el)} 右緣 ${Math.round(r.right)} > 儲存格 ${Math.round(c.right)}`)
    }
  }

  // 不自然的換行：8 字以內的短文字（技能名、標籤）被拆成兩行，例如「自生II」變成「自生／II」。
  // 瀏覽器面板的手機截圖有時停在舊畫面，用這項取代目視
  // 比較結果與收合的日誌選擇（名稱過長時標籤被擠成直排）
  for (const root of [section, document.querySelector('.picked-logs')].filter(Boolean)) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      const text = node.textContent.trim()
      const el = node.parentElement
      if (!text || text.length > 8 || !el || !visible(el)) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)))
      if (lines.size > 1) split.add(label(el))
    }
  }

  for (const b of [...document.querySelectorAll('.help-tip-button')].filter(visible)) {
    const r = b.getBoundingClientRect()
    tips.push(`${Math.round(r.width)}x${Math.round(r.height)}`)
  }
  for (const h of [...(section?.querySelectorAll('h2, h3') ?? [])].filter(visible)) {
    const text = h.textContent.replace('?', '').trim()
    if (!headings.includes(text)) headings.push(text)
  }
  for (const e of [...document.querySelectorAll('.error')].filter(visible)) errors.add(e.textContent.trim().slice(0, 80))
  }

  // 點擊後 React 在微任務中才更新畫面：每次切換後稍等再檢查
  const detailTabs = [...document.querySelectorAll('.detail-tabs > .tab-list .tab')]
  const original = detailTabs.find((t) => t.getAttribute('aria-selected') === 'true')
  if (detailTabs.length === 0) check()
  for (const tab of detailTabs) {
    tab.click()
    await new Promise((r) => setTimeout(r, 100))
    headings.push(`[${tab.textContent.trim()}]`)
    check()
  }
  original?.click()
  const tipSizes = [...new Set(tips)]

  return JSON.stringify({
    viewport: vw,
    loaded: !!section && !!section.querySelector('.compare-summary'),
    horizontalScroll: document.documentElement.scrollWidth > vw + 1 ? document.documentElement.scrollWidth : false,
    offscreen: [...offscreen].slice(0, 15),
    clipped: [...clipped].slice(0, 15),
    overflowCell: [...overflowCell].slice(0, 15),
    innerScroll: [...innerScroll].slice(0, 15),
    split: [...split].slice(0, 15),
    helpTipSizes: tipSizes,
    helpTips: tips.length,
    headings,
    errors: [...errors],
  }, null, 2)
})()
