import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type CollectionsPolicy } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, Field, Panel, SectionTitle, TextInput } from '../../components/ui'

/**
 * The company's collections policy: the defaults a party inherits when it says nothing itself.
 *
 * Every field here is a business's opinion rather than an accounting rule, which is why none of
 * it is hardcoded. Ageing bands and the provisioning ladder have no per-party override, because a
 * report whose columns changed from row to row would be unreadable.
 */
const DEFAULTS: CollectionsPolicy = {
  interestRateBp: 0,
  interestGraceDays: 0,
  bandCuts: [30, 60, 90],
  provisionPolicy: [
    { afterDays: 180, pct: 25 },
    { afterDays: 365, pct: 50 },
    { afterDays: 730, pct: 100 }
  ],
  reminderMinOverdueDays: 1,
  contact: null
}

export function CollectionsSection(): React.JSX.Element {
  const { user } = useSession()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['collectionsPolicy'], queryFn: api.receivables.policy })
  const canEdit = user == null || user.role === 'owner'

  const [interestPct, setInterestPct] = useState('')
  const [grace, setGrace] = useState('')
  const [bands, setBands] = useState('')
  const [ladder, setLadder] = useState('')
  const [minOverdue, setMinOverdue] = useState('')
  const [contact, setContact] = useState('')

  useEffect(() => {
    const p = data ?? DEFAULTS
    setInterestPct(p.interestRateBp ? (p.interestRateBp / 100).toString() : '')
    setGrace(p.interestGraceDays ? String(p.interestGraceDays) : '')
    setBands(p.bandCuts.join(', '))
    setLadder(p.provisionPolicy.map((r) => `${r.afterDays}:${r.pct}`).join(', '))
    setMinOverdue(String(p.reminderMinOverdueDays))
    setContact(p.contact ?? '')
  }, [data])

  const save = useMutation({
    mutationFn: (input: CollectionsPolicy) => api.receivables.setPolicy(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['collectionsPolicy'] })
      toast.push('success', 'Collections policy saved')
    },
    onError: (err: Error) => toast.push('error', err.message)
  })

  const submit = (): void => {
    const cuts = bands
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
    if (cuts.length === 0) return void toast.push('error', 'Give at least one ageing band, e.g. 30, 60, 90')

    const rules: { afterDays: number; pct: number }[] = []
    for (const part of ladder.split(',')) {
      const [days, pct] = part.split(':').map((s) => Number(s.trim()))
      if (!Number.isFinite(days) || !Number.isFinite(pct)) {
        return void toast.push('error', 'Write the provision ladder as days:percent pairs, e.g. 180:25, 365:50')
      }
      rules.push({ afterDays: Math.round(days as number), pct: Math.round(pct as number) })
    }

    save.mutate({
      interestRateBp: interestPct.trim() ? Math.round(Number(interestPct) * 100) : 0,
      interestGraceDays: grace.trim() ? Math.round(Number(grace)) : 0,
      bandCuts: cuts.map((n) => Math.round(n)),
      provisionPolicy: rules,
      reminderMinOverdueDays: minOverdue.trim() ? Math.round(Number(minOverdue)) : 1,
      contact: contact.trim() || null
    })
  }

  if (!canEdit) {
    return (
      <div>
        <SectionTitle>Collections</SectionTitle>
        <div className="rounded-md border border-blue/40 bg-blue/10 px-3.5 py-2.5 text-body-sm text-blue">
          Only the owner can change the collections policy. What it says already applies to every
          report on the Collections screen.
        </div>
      </div>
    )
  }

  return (
    <div>
      <SectionTitle
        right={
          <Button variant="primary" data-testid="btn-collections-save" disabled={save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        }
      >
        Collections
      </SectionTitle>

      <Panel className="p-4">
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Default interest % p.a."
            hint="On overdue bills, where a party has not agreed its own rate. Blank or 0 charges nothing."
          >
            <TextInput
              data-testid="input-collections-interest"
              value={interestPct}
              onChange={(e) => setInterestPct(e.target.value)}
              className="num text-right"
              placeholder="0"
              inputMode="decimal"
            />
          </Field>
          <Field label="Grace days" hint="Days past due before interest starts running. Everybody forgives the first week.">
            <TextInput
              value={grace}
              onChange={(e) => setGrace(e.target.value)}
              className="num text-right"
              placeholder="0"
              inputMode="numeric"
            />
          </Field>
          <Field
            label="Ageing bands"
            hint="Cut points in days, ascending. 30, 60, 90 gives the usual four columns; a trade on 45-day terms might want 45, 90, 180."
          >
            <TextInput
              data-testid="input-collections-bands"
              value={bands}
              onChange={(e) => setBands(e.target.value)}
              className="num"
              placeholder="30, 60, 90"
            />
          </Field>
          <Field
            label="Provision ladder"
            hint="days:percent pairs. 180:25 means a quarter of anything more than 180 days overdue is doubtful."
          >
            <TextInput
              data-testid="input-collections-ladder"
              value={ladder}
              onChange={(e) => setLadder(e.target.value)}
              className="num"
              placeholder="180:25, 365:50, 730:100"
            />
          </Field>
          <Field label="Remind after" hint="Days overdue before a party appears in a bulk reminder run.">
            <TextInput
              value={minOverdue}
              onChange={(e) => setMinOverdue(e.target.value)}
              className="num text-right"
              placeholder="1"
              inputMode="numeric"
            />
          </Field>
          <Field label="Contact line" hint="Printed under the signature on reminders and statements.">
            <TextInput
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="Accounts — 98765 43210"
            />
          </Field>
        </div>
      </Panel>

      <p className="mt-3 text-hint text-muted">
        A party can override the interest rate and grace days on its own master. Bands and the
        ladder are company-wide: an ageing report whose columns changed from row to row would be
        unreadable, and a provision is an accounting policy rather than a per-customer negotiation.
      </p>
    </div>
  )
}
