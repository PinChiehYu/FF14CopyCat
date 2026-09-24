import { useState } from 'react'
import { getAccessToken, isConfigured, logout, startLogin } from './fflogs/auth'
import { parseReportUrl } from './fflogs/url'

function LogInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const ref = value.trim() ? parseReportUrl(value) : null

  return (
    <section className="log-input">
      <label>
        {label}
        <input
          type="url"
          placeholder="https://www.fflogs.com/reports/..."
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      {value.trim() && !ref && <p className="error">無法辨識的 FFLogs 報告連結</p>}
      {ref && (
        <dl>
          <dt>報告</dt>
          <dd>{ref.reportCode}</dd>
          <dt>戰鬥</dt>
          <dd>{ref.fight ?? '（未指定）'}</dd>
          <dt>角色</dt>
          <dd>{ref.sourceId ?? '（未指定）'}</dd>
        </dl>
      )}
    </section>
  )
}

export default function App() {
  const [mine, setMine] = useState('')
  const [reference, setReference] = useState('')
  const [loggedIn, setLoggedIn] = useState(() => getAccessToken() !== null)

  return (
    <>
      <h1>FF14 CopyCat</h1>
      <p className="subtitle">比較你與高階玩家的 FFLogs 日誌，找出技能循環與站位的差異。</p>

      <div className="auth">
        {!isConfigured() ? (
          <span className="error">尚未設定 VITE_FFLOGS_CLIENT_ID，無法登入 FFLogs。</span>
        ) : loggedIn ? (
          <>
            <span>已登入 FFLogs</span>
            <button
              onClick={() => {
                logout()
                setLoggedIn(false)
              }}
            >
              登出
            </button>
          </>
        ) : (
          <button onClick={() => void startLogin()}>使用 FFLogs 帳號登入</button>
        )}
      </div>

      <div className="logs">
        <LogInput label="我的日誌" value={mine} onChange={setMine} />
        <LogInput label="參考日誌（高階玩家）" value={reference} onChange={setReference} />
      </div>
    </>
  )
}
