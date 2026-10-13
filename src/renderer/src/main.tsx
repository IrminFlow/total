import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { applyStoredAppearance } from './state/stores'
import { bindQueryCacheToCompany } from './lib/companyCache'
import { configureI18n } from '@shared/i18n'
import './app.css'

applyStoredAppearance()
// Dev builds show an unknown i18n key as itself and warn once; production falls back silently.
configureI18n({ dev: (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true })

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 5_000, refetchOnWindowFocus: false }
  }
})
bindQueryCacheToCompany(queryClient)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
)
