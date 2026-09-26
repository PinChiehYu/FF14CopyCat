import { useEffect, useRef } from 'react'
import { formatFightTime } from '../analysis/timeline'

const PLAYBACK_SPEEDS = [1, 2, 4, 8]
// 前後跳的秒數
const SKIP_MS = 5000
// 播放時更新游標的最短間隔
const FRAME_MS = 50

/**
 * 播放列：播放／暫停（空白鍵）、倍速、前後跳 5 秒與時間拉桿，控制共用的時間游標（參考時間）。
 * 播放時以 requestAnimationFrame 依實際經過時間 × 倍速推進游標，到結尾自動停止。
 */
export function Playback({
  cursor,
  duration,
  playing,
  speed,
  onSeek,
  onPlayingChange,
  onSpeedChange,
}: {
  cursor: number
  duration: number
  playing: boolean
  speed: number
  onSeek: (t: number) => void
  onPlayingChange: (playing: boolean) => void
  onSpeedChange: (speed: number) => void
}) {
  // 動畫迴圈讀最新的游標，不因每一格的游標更新而重建
  const latest = useRef({ cursor, duration, speed, onSeek, onPlayingChange })
  useEffect(() => {
    latest.current = { cursor, duration, speed, onSeek, onPlayingChange }
  })

  useEffect(() => {
    if (!playing) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      // 最多每 50 ms 更新一次游標：整頁（時間軸有上千個圖示）跟著重繪，太頻繁會卡
      if (now - last < FRAME_MS) {
        frame = requestAnimationFrame(tick)
        return
      }
      const { cursor, duration, speed, onSeek, onPlayingChange } = latest.current
      const next = cursor + (now - last) * speed
      last = now
      if (next >= duration) {
        onSeek(duration)
        onPlayingChange(false)
        return
      }
      onSeek(next)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  // 空白鍵播放／暫停（輸入框、按鈕、下拉選單有焦點時不攔截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, button, [contenteditable="true"]')) return
      e.preventDefault()
      const { cursor, duration, onSeek, onPlayingChange } = latest.current
      if (!playing && cursor >= duration) onSeek(0)
      onPlayingChange(!playing)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playing])

  const seek = (t: number) => onSeek(Math.min(duration, Math.max(0, t)))
  const toggle = () => {
    if (!playing && cursor >= duration) onSeek(0)
    onPlayingChange(!playing)
  }

  return (
    <div className="playback" role="group" aria-label="播放控制">
      <button type="button" className="playback-play" onClick={toggle} title="播放／暫停（空白鍵）" aria-label={playing ? '暫停' : '播放'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <button type="button" onClick={() => seek(cursor - SKIP_MS)} title="倒退 5 秒">
        −5s
      </button>
      <button type="button" onClick={() => seek(cursor + SKIP_MS)} title="快轉 5 秒">
        +5s
      </button>
      <input
        type="range"
        className="playback-scrubber"
        min={0}
        max={duration}
        step={100}
        value={Math.min(cursor, duration)}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="時間"
      />
      <span className="playback-time">
        {formatFightTime(cursor)} / {formatFightTime(duration)}
      </span>
      <select value={speed} onChange={(e) => onSpeedChange(Number(e.target.value))} aria-label="播放速度">
        {PLAYBACK_SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
    </div>
  )
}
