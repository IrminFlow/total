import './e2eClock'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { applyStoredAppearance } from './state/stores'
import { bindQueryCacheToCompany } from './lib/companyCache'
import { bindMasterEvents } from './lib/masterEvents'
import { configureI18n } from '@shared/i18n'
import './app.css'
import { installPcShortcutLabels } from './lib/platform'

applyStoredAppearance()
// Dev builds show an unknown i18n key as itself and warn once; production falls back silently.
configureI18n({ dev: (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true })

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 5_000, refetchOnWindowFocus: false }
  }
})
bindQueryCacheToCompany(queryClient)
// to-do §4: a master created or changed elsewhere refreshes the cached lists (Labels tab, pickers).
bindMasterEvents(queryClient)
// WP 7.3: ⌘K / ⌥A labels read Ctrl+K / Alt+A on Windows (the handlers accept Ctrl already).
installPcShortcutLabels()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
)
