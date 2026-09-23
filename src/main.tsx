import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// 全局错误上报：JS 错误/未处理 Promise 之前是黑洞（白屏、卡死都没有痕迹）。
// 现在统一转给原生宿主写进 lifecycle.log，出问题可回溯。
const reportWebError = (text: string) => {
  try {
    const message = String(text).slice(0, 400)
    ;(window as unknown as { chrome?: { webview?: { postMessage: (payload: unknown) => void } } }).chrome?.webview?.postMessage({ type: 'native-log-error', message })
  } catch {
    /* 上报失败不影响主流程 */
  }
}
window.addEventListener('error', (event) => {
  reportWebError(`error: ${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`)
})
window.addEventListener('unhandledrejection', (event) => {
  reportWebError(`unhandledrejection: ${String(event.reason).slice(0, 300)}`)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
