import { useState } from 'react'
import { api } from '../lib/client'
import { useSession, useToasts } from '../state/stores'
import { Button, Field, Panel, SectionTitle, Select, TextInput } from '../components/ui'
import { GST_STATES } from '@shared/gst/states'
import { validateGstin } from '@shared/gst/validate'

export function CompanyInfoScreen(): React.JSX.Element {
  const { info, slug, setCompany } = useSession()
  const toast = useToasts()
  const [name, setName] = useState(info?.name ?? '')
  const [stateCode, setStateCode] = useState(info?.stateCode ?? '27')
  const [gstin, setGstin] = useState(info?.gstin ?? '')
  const [regType, setRegType] = useState(info?.gstRegistrationType ?? 'unregistered')
  const [address, setAddress] = useState(info?.address ?? '')
  const [email, setEmail] = useState(info?.email ?? '')
  const [phone, setPhone] = useState(info?.phone ?? '')

  const gstinCheck = gstin.trim() ? validateGstin(gstin) : null
  const gstinError = gstinCheck && !gstinCheck.valid ? 'Invalid GSTIN — check each character' : null

  const save = async (): Promise<void> => {
    try {
      if (gstinError) return void toast.push('error', gstinError)
      const updated = await api.company.updateInfo({
        name: name.trim(),
        stateCode,
        gstin: gstin.trim() ? gstin.trim().toUpperCase() : null,
        gstRegistrationType: gstin.trim() ? (regType === 'unregistered' ? 'regular' : regType) : 'unregistered',
        address,
        booksFrom: info?.booksFrom ?? 2025,
        email: email.trim() || null,
        phone: phone.trim() || null
      })
      if (slug) setCompany(slug, updated)
      toast.push('success', 'Company details saved')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <SectionTitle>Company details</SectionTitle>
      <Panel className="flex flex-col gap-4 p-5">
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State">
            <Select value={stateCode} onChange={(e) => setStateCode(e.target.value)}>
              {Object.entries(GST_STATES).map(([code, label]) => (
                <option key={code} value={code}>
                  {code} — {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Registration">
            <Select value={regType} onChange={(e) => setRegType(e.target.value as typeof regType)} disabled={!gstin.trim()}>
              <option value="regular">Regular</option>
              <option value="composition">Composition</option>
              <option value="unregistered">Unregistered</option>
            </Select>
          </Field>
        </div>
        <Field label="GSTIN" error={gstinError} hint="Needed for GSTR exports">
          <TextInput value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} className="num" />
        </Field>
        <Field label="Address">
          <TextInput value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Email">
            <TextInput value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Phone">
            <TextInput value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-between">
          <Button
            onClick={async () => {
              try {
                const r = await api.tally.import()
                if (!r) return
                toast.push(
                  'success',
                  `Imported from Tally: ${r.groups} groups, ${r.ledgers} ledgers, ${r.units} units, ${r.items} items, ${r.vouchers} vouchers${r.skipped ? ` (${r.skipped} skipped)` : ''}`
                )
                if (r.warnings.length) {
                  toast.push('warning', `${r.warnings.length} warning${r.warnings.length > 1 ? 's' : ''}: ${r.warnings[0]}${r.warnings.length > 1 ? ' …' : ''}`)
                }
              } catch (err) {
                toast.push('error', (err as Error).message)
              }
            }}
          >
            Import from Tally (XML)
          </Button>
          <Button variant="primary" onClick={() => void save()}>
            Save details
          </Button>
        </div>
      </Panel>
      <p className="mt-3 text-[12px] text-muted">
        Tally import reads Masters and Voucher XML exports (Gateway of Tally → Display → List of Accounts / Day Book → Export → XML). Import masters first, then vouchers. A backup is taken automatically before importing.
      </p>
      <p className="mt-3 text-[12px] text-muted">
        Books from FY {info?.booksFrom}-{((info?.booksFrom ?? 0) + 1) % 100}. Data lives in ~/Documents/total/companies/{slug} — back it up like any folder.
      </p>
    </div>
  )
}
