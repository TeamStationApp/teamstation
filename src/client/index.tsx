import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App'

const rootElement = document.getElementById('root')
if (rootElement == null) {
  if (typeof React === 'undefined') {
    // Dummy check to prevent removal of the React import
    console.error('React is not defined')
    throw new Error('React is not defined')
  }
  console.error(
    'Root element not found. Check your HTML for <div id="root"></div>'
  )
  throw new Error('Root element not found')
}

const root = ReactDOM.createRoot(rootElement)
root.render(<App />)
