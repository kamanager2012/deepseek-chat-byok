import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupTheme()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)

if (
  'serviceWorker' in navigator &&
  (window.location.protocol === 'https:' ||
    (window.location.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(window.location.hostname)))
) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {})
  })
}
