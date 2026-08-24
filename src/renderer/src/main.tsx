import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { applyKeyboardOnly, applyMotion, applyTextSize, applyTheme, initialKeyboardOnly, initialMotion, initialTextSize, initialTheme } from './state/stores'
import './app.css'

// Before the first render, not in an effect: a user who chose Largest must not watch the app
// paint at the default size and then jump.
applyTheme(initialTheme())
applyTextSize(initialTextSize())
applyMotion(initialMotion())
applyKeyboardOnly(initialKeyboardOnly())

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 5_000, refetchOnWindowFocus: false }
  }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
)
