import { useEffect, useState } from 'react'
import { shareUrl } from '../pageQuery'
import type { Selection } from './load'

// 複製後按鈕顯示結果的時間
const FEEDBACK_MS = 2000

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // 不支援或被拒絕（非 https、頁面沒有焦點等）時退回舊的複製方式
  }
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const ok = document.execCommand('copy')
  area.remove()
  if (!ok) throw new Error('copy failed')
}

/** 複製分享連結的按鈕：按下後短暫顯示「已複製」；失敗時以對話框（與滑鼠提示）顯示連結讓使用者自行複製。 */
export function ShareLink({ mine, reference }: { mine: Selection; reference: Selection | { average: string } }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const url = shareUrl(mine, reference, `${window.location.origin}${window.location.pathname}`)
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), FEEDBACK_MS)
    return () => clearTimeout(timer)
  }, [state])
  return (
    <button
      type="button"
      className={`share-link${state === 'copied' ? ' copied' : ''}`}
      title={state === 'failed' ? `無法自動複製，請手動複製：\n${url}` : '複製這次比較的連結（包含兩邊的戰鬥與角色），開啟後直接顯示同樣的比較'}
      onClick={() =>
        copyText(url).then(
          () => setState('copied'),
          () => {
            setState('failed')
            // 手機上看不到滑鼠提示：以對話框顯示連結讓使用者手動複製
            window.prompt('無法自動複製，請手動複製這個連結：', url)
          },
        )
      }
    >
      <LinkIcon />
      <span aria-live="polite">{state === 'copied' ? '已複製' : state === 'failed' ? '複製失敗' : '複製分享連結'}</span>
    </button>
  )
}

/** 連結圖示（大小跟著文字） */
function LinkIcon() {
  return (
    <svg className="share-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6.5 9.5l3-3M7 4.5l1.3-1.3a2.8 2.8 0 014 4L11 8.5M9 11.5l-1.3 1.3a2.8 2.8 0 01-4-4L5 7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}
