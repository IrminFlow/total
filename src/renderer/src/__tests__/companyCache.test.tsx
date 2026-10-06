// Query keys aren't company-namespaced, so switching company must empty the cache before the next
// company's tree renders (bindQueryCacheToCompany, wired in main.tsx).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { CompanyInfo } from '@shared/domain'
import { bindQueryCacheToCompany } from '../lib/companyCache'
import { useSession } from '../state/stores'

const INFO: CompanyInfo = {
  name: 'A', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '',
  booksFrom: 2025, email: null, phone: null, pan: null, tan: null
}

let client: QueryClient
let unbind: () => void

beforeEach(() => {
  useSession.getState().clearCompany()
  client = new QueryClient()
  unbind = bindQueryCacheToCompany(client)
})

afterEach(() => {
  unbind()
  client.clear()
})

describe('bindQueryCacheToCompany', () => {
  it('clears the cache when a company opens, switches or closes', () => {
    useSession.getState().setCompany('company-a', INFO)
    client.setQueryData(['ledgers'], ['A ledger'])
    // Closing (back to the company picker) drops A's data synchronously…
    useSession.getState().clearCompany()
    expect(client.getQueryData(['ledgers'])).toBeUndefined()

    client.setQueryData(['registry'], { companies: [] })
    // …and opening B starts from an empty cache, so B's screens can never paint A's ledgers.
    useSession.getState().setCompany('company-b', { ...INFO, name: 'B' })
    expect(client.getQueryData(['registry'])).toBeUndefined()

    client.setQueryData(['ledgers'], ['B ledger'])
    useSession.getState().setCompany('company-c', { ...INFO, name: 'C' }) // direct switch
    expect(client.getQueryData(['ledgers'])).toBeUndefined()
  })

  it('keeps the cache for same-company updates (Company Info save, lock/unlock)', () => {
    useSession.getState().setCompany('company-a', INFO)
    client.setQueryData(['ledgers'], ['A ledger'])
    useSession.getState().setCompany('company-a', { ...INFO, name: 'A renamed' })
    useSession.getState().setLocked(true)
    useSession.getState().setLocked(false)
    expect(client.getQueryData(['ledgers'])).toEqual(['A ledger'])
  })
})
