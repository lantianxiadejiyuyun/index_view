import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import './index.css'
import './styles/appearance-themes.css'
import './components/folder-cards.css'
import './styles/folder-grid.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root 不存在，index.html 被改坏了')

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
