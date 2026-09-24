import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { handleRedirect } from './fflogs/auth'

// 在 React 掛載前處理 OAuth 回呼，避免 StrictMode 重複執行權杖交換。
handleRedirect()
  .catch((err: unknown) => console.error(err))
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
