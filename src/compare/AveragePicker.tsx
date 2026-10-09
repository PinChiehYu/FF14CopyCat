import { useState } from 'react'
import { formatFightTime } from '../analysis/timeline'
import { AVERAGE_TIERS, type AverageSampleData, type AverageTier } from '../fflogs/client'
import { jobName } from '../jobs/names'
import { HelpTip } from './HelpTip'
import type { AverageInfo } from './averageSide'

/** 參考改用前輩平均：選 PR 區間（取代貼參考日誌的欄位） */
export function AveragePicker({
  tier,
  counts,
  info,
  job,
  onChange,
  onSingle,
  onPickSample,
}: {
  tier: AverageTier
  /** 各區間可用的樣本數；查詢中或失敗時為 null（不顯示） */
  counts: Record<AverageTier, number> | null
  /** 目前區間的樣本資訊（比較結果載入後才有） */
  info: AverageInfo | null
  /** 我的職業（FFLogs subType） */
  job: string | null
  onChange: (tier: AverageTier) => void
  onSingle: () => void
  /** 在樣本清單中選了一場：改以那一場為參考 */
  onPickSample: (sample: AverageSampleData) => void
}) {
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
              '區間按鈕上的數字為可用的樣本數；預設為比你這場的 PR 高一段的區間。',
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
            // 沒有可用樣本的區間停用（目前選的照常可點，顯示說明）
            disabled={counts?.[t.tier] === 0 && t.tier !== tier}
            title={counts?.[t.tier] === 0 ? '這個區間還沒有可用的樣本' : undefined}
            onClick={() => onChange(t.tier)}
          >
            {t.label}
            {counts && <span className="tab-count">{counts[t.tier]}</span>}
          </button>
        ))}
      </div>
      {info && job && <AverageSummary info={info} job={job} onPick={onPickSample} />}
    </section>
  )
}

const dateTime = (ms: number) => {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 前輩平均的樣本資訊列與樣本清單；點選樣本即改以那一場為參考（單一日誌） */
export function AverageSummary({ info, job, onPick }: { info: AverageInfo; job: string; onPick: (sample: AverageSampleData) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="average-summary">
      {/* 精簡成一行（職業已在我的日誌欄位），完整說明在滑鼠提示；樣本清單按鈕靠右 */}
      <p className="hint">
        <span
          title={`繁中服 ${jobName(job)}${info.slot ? `（${info.slot}）` : ''}：用了 ${info.used} 筆樣本，區間內共 ${info.count} 場擊殺${info.updatedAt !== null ? `，樣本更新於 ${dateTime(info.updatedAt)}` : ''}`}
        >
          {info.slot && `${info.slot}・`}
          樣本 {info.used}／{info.count} 場
          {info.updatedAt !== null && `・${dateTime(info.updatedAt)} 更新`}
        </span>
        <button type="button" className="average-switch" aria-expanded={open} onClick={() => setOpen(!open)}>
          樣本清單 {open ? '▴' : '▾'}
        </button>
      </p>
      {open && (
        <ul className="average-samples">
          {info.samples.map((s) => (
            <li key={`${s.report}:${s.fight}:${s.actor}`}>
              <button type="button" onClick={() => onPick(s)} title="改以這一場為參考">
                <span className="average-sample-name" title={`${s.name} @ ${s.server}`}>
                  {s.name}
                  <span className="option-server"> @ {s.server}</span>
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
