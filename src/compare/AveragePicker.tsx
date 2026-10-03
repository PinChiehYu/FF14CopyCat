import { useState } from 'react'
import { formatFightTime } from '../analysis/timeline'
import { AVERAGE_TIERS, type AverageSampleData, type AverageTier } from '../fflogs/client'
import { jobName } from '../jobs/names'
import { HelpTip } from './HelpTip'
import type { AverageInfo } from './averageSide'

/** 參考改用前輩平均：選 PR 區間（取代貼參考日誌的欄位） */
export function AveragePicker({ tier, onChange, onSingle }: { tier: AverageTier; onChange: (tier: AverageTier) => void; onSingle: () => void }) {
  return (
    <section className="log-input average-picker">
      <div className="log-head">
        <label>
          參考：前輩平均
          <HelpTip
            text={[
              '前輩平均：本站收錄的繁中服擊殺中，同 Boss、同職業（坦克再分 MT／ST）、這個 PR 區間的前輩最多 30 位（依 rDPS 平均分布，有死亡的不選），把他們的施放依 Boss 機制換算成你的時間後合成。',
              'GCD 取每個位置最常見的技能，能力技取過半數前輩有用的時間；時間軸的圖示越淡代表前輩之間越不一致。',
              '前輩平均沒有站位、效果與死亡資料：Boss 機制差異、站位差異不顯示，技能窗口、DoT 等只評自己。',
            ].join('\n')}
          />
        </label>
        <button type="button" className="average-switch" onClick={onSingle}>
          改貼參考日誌
        </button>
      </div>
      <div className="tab-list average-tiers" role="group" aria-label="前輩的 PR 區間">
        {AVERAGE_TIERS.map((t) => (
          <button
            key={t.tier}
            type="button"
            className={`tab${t.tier === tier ? ' active' : ''}`}
            aria-pressed={t.tier === tier}
            onClick={() => onChange(t.tier)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </section>
  )
}

const dateTime = (ms: number) => {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 前輩平均的樣本資訊列與樣本清單；點選樣本即改以那一場為參考（單一日誌） */
export function AverageSummary({ info, job, onPick }: { info: AverageInfo; job: string; onPick: (sample: AverageSampleData) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="average-summary">
      {/* 每段不拆行，段與段之間換行 */}
      <p className="hint">
        <span>
          繁中服 {jobName(job)}
          {info.slot && `（${info.slot}）`}
        </span>
        <span>用了 {info.used} 筆樣本</span>
        <span>區間內共 {info.count} 場擊殺</span>
        {info.updatedAt !== null && <span>樣本更新於 {dateTime(info.updatedAt)}</span>}
        <button type="button" className="average-switch" aria-expanded={open} onClick={() => setOpen(!open)}>
          樣本清單 {open ? '▴' : '▾'}
        </button>
      </p>
      {open && (
        <ul className="average-samples">
          {info.samples.map((s) => (
            <li key={`${s.report}:${s.fight}:${s.actor}`}>
              <button type="button" onClick={() => onPick(s)} title="改以這一場為參考">
                <span className="average-sample-name">
                  {s.name} @ {s.server}
                </span>
                <span>PR {s.pr}</span>
                <span>{Math.round(s.rdps).toLocaleString()}</span>
                <span>{formatFightTime(s.duration).replace(/\.\d$/, '')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
