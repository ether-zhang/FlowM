import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './app/App'
import { parseUiLanguage, UI_LANGUAGE_STORAGE, uiText } from './app/uiText'
import { IS_TAURI } from './runtime'

const text = uiText[parseUiLanguage(localStorage.getItem(UI_LANGUAGE_STORAGE))]

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {IS_TAURI ? <App /> : <main className="desktop-required"><div><h1>FlowM</h1><p>{text.app.desktopOnly}</p></div></main>}
  </StrictMode>,
)
