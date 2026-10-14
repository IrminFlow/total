// WP 10.1: the Ask Total question corpus — phrasings (English, Hinglish, a little Hindi, typos,
// with and without amounts and dates) → the intent and slots the classifier must pick. Pure.
import { describe, expect, it } from 'vitest'
import { classify, normalise, periodOf } from './classify'

const TODAY = '2026-10-14'

type Expect = Record<string, unknown>
const CORPUS: [string, Expect][] = [
  // ---- who owes me / what do I owe / does X owe me ----
  ['who owes me', { kind: 'owed', side: 'receivable', party: undefined }],
  ['Who owes me money?', { kind: 'owed', side: 'receivable', party: undefined }],
  ['how much do customers owe me', { kind: 'owed', side: 'receivable', party: undefined }],
  ['kis kis se paise lene hai', { kind: 'owed', side: 'receivable', party: undefined }],
  ['kaun kaun udhaar pe hai', { kind: 'owed', side: 'receivable', party: undefined }],
  ['outstanding', { kind: 'owed', side: 'receivable', party: undefined }],
  ['does Ramesh owe me anything?', { kind: 'owed', side: 'receivable', party: 'ramesh' }],
  ['how much does Sita Traders owe', { kind: 'owed', side: 'receivable', party: 'sita traders' }],
  ['Ramesh ka kitna baki hai', { kind: 'owed', side: 'receivable', party: 'ramesh' }],
  ['what do I owe', { kind: 'owed', side: 'payable', party: undefined }],
  ['mujhe kitna dena hai', { kind: 'owed', side: 'payable', party: undefined }],
  ['do I owe Mohan anything', { kind: 'owed', side: 'payable', party: 'mohan' }],
  ['Mohan ko kitna dena hai', { kind: 'owed', side: 'payable', party: 'mohan' }],
  ['bills to pay', { kind: 'owed', side: 'payable', party: undefined }],
  // ---- GST ----
  ['how much GST do I have to pay', { kind: 'gst' }],
  ['GST kitna bharna hai', { kind: 'gst' }],
  ['when is gst due?', { kind: 'gst' }],
  ['gst kab bharna hai', { kind: 'gst' }],
  ['GST', { kind: 'gst' }],
  ['जीएसटी कितना है', { kind: 'gst' }],
  // ---- profit / sales / purchases / expenses for a period ----
  ['kitna profit hua is mahine', { kind: 'figure', measure: 'profit', period: { rule: 'thisMonth', from: '2026-10-01', to: '2026-10-14' } }],
  ['what is my profit this month', { kind: 'figure', measure: 'profit', period: { rule: 'thisMonth' } }],
  ['profitt last month', { kind: 'figure', measure: 'profit', period: { rule: 'lastMonth', from: '2026-09-01', to: '2026-09-30' } }],
  ['pichle mahine ka munafa', { kind: 'figure', measure: 'profit', period: { rule: 'lastMonth' } }],
  ['did I make money this year', { kind: 'figure', measure: 'profit', period: { rule: 'fyToDate', from: '2026-04-01', to: '2026-10-14' } }],
  ['is saal kitna fayda hua', { kind: 'figure', measure: 'profit', period: { rule: 'fyToDate' } }],
  ['sales today', { kind: 'figure', measure: 'sales', period: { rule: 'today', from: TODAY, to: TODAY } }],
  ['aaj ki bikri', { kind: 'figure', measure: 'sales', period: { rule: 'today' } }],
  ['how much did I sell yesterday', { kind: 'figure', measure: 'sales', period: { rule: 'yesterday', from: '2026-10-13' } }],
  ['sales in july', { kind: 'figure', measure: 'sales', period: { rule: 'month', from: '2026-07-01', to: '2026-07-31' } }],
  ['july ki sales', { kind: 'figure', measure: 'sales', period: { rule: 'month', from: '2026-07-01' } }],
  ['sales in december', { kind: 'figure', measure: 'sales', period: { rule: 'month', from: '2025-12-01', to: '2025-12-31' } }],
  ['total sales', { kind: 'figure', measure: 'sales', period: { rule: 'thisMonth' }, periodSaid: false }],
  ['purchases last month', { kind: 'figure', measure: 'purchases', period: { rule: 'lastMonth' } }],
  ['pichle mahine kitni kharidi hui', { kind: 'figure', measure: 'purchases', period: { rule: 'lastMonth' } }],
  ['expences this month', { kind: 'figure', measure: 'expenses', period: { rule: 'thisMonth' } }],
  ['is mahine kitna kharcha hua', { kind: 'figure', measure: 'expenses', period: { rule: 'thisMonth' } }],
  ['how much did I spend last year', { kind: 'figure', measure: 'expenses', period: { rule: 'lastFy', from: '2025-04-01', to: '2026-03-31' } }],
  ['इस महीने का मुनाफा', { kind: 'figure', measure: 'profit', period: { rule: 'thisMonth' } }],
  // ---- cash in hand / bank balance ----
  ['cash in hand', { kind: 'money', which: 'cash' }],
  ['how much cash do I have', { kind: 'money', which: 'cash' }],
  ['galle me kitna cash hai', { kind: 'money', which: 'cash' }],
  ['bank balance', { kind: 'money', which: 'bank' }],
  ['bank me kitna hai', { kind: 'money', which: 'bank' }],
  ['how much money do I have', { kind: 'money', which: 'both' }],
  ['kitna paisa hai', { kind: 'money', which: 'both' }],
  // ---- stock ----
  ['stock of rice', { kind: 'stock', item: 'rice' }],
  ['how many bags left', { kind: 'stock', item: 'bags' }],
  ['rice ka stock', { kind: 'stock', item: 'rice' }],
  ['kitne bags bache hai', { kind: 'stock', item: 'bags' }],
  ['what is running low', { kind: 'stock', low: true }],
  ['kya khatam ho raha hai', { kind: 'stock', low: true }],
  ['stock', { kind: 'stock', item: undefined }],
  // ---- open ----
  ['open bank', { kind: 'open', target: 'bank' }],
  ['go to customers', { kind: 'open', target: 'customers' }],
  ['open the ledger for Ramesh', { kind: 'open', target: 'ledger for ramesh' }],
  ['stock kholo', { kind: 'open', target: 'stock' }],
  ['show reports', { kind: 'open', target: 'reports' }],
  // ---- how do I ----
  ['how do I make a bill', { kind: 'howto', task: 'bill' }],
  ['bill kaise banaye', { kind: 'howto', task: 'bill' }],
  ['how to record a purchase', { kind: 'howto', task: 'purchase' }],
  ['how do I take a backup', { kind: 'howto', task: 'backup' }],
  ['how can I return goods to a supplier', { kind: 'howto', task: 'returnPurchase' }],
  ['galti ho gayi kaise theek kare', { kind: 'howto', task: 'undo' }],
  ['how do I import my bank statement', { kind: 'howto', task: 'bank' }],
  ['hindi kaise kare', { kind: 'howto', task: 'language' }],
  // ---- what does X mean ----
  ['what is a voucher', { kind: 'meaning', term: 'voucher' }],
  ['ledger kya hai', { kind: 'meaning', term: 'ledger' }],
  // ---- entries ----
  ['paid 2,500 rent in cash', { kind: 'entry', entry: { action: 'money_out', amount: 250000, what: 'rent', how: 'cash', party: undefined } }],
  ['paid 500 for tea in cash', { kind: 'entry', entry: { action: 'money_out', amount: 50000, what: 'tea', how: 'cash' } }],
  ['Paid ₹1,200 electricity bill by UPI', { kind: 'entry', entry: { action: 'money_out', amount: 120000, what: 'electricity', how: 'upi' } }],
  ['chai pe 200 kharch kiye', { kind: 'entry', entry: { action: 'money_out', amount: 20000, what: 'chai' } }],
  ['paid Mohan 2000 yesterday', { kind: 'entry', entry: { action: 'money_out', amount: 200000, party: 'mohan', date: '2026-10-13' } }],
  ['maine Mohan ko 2000 diye', { kind: 'entry', entry: { action: 'money_out', amount: 200000, party: 'mohan' } }],
  ['Ramesh ko 5000 mila', { kind: 'entry', entry: { action: 'money_in', amount: 500000, party: 'ramesh', readAs: 'koMila' } }],
  ['Ramesh se 5000 mile', { kind: 'entry', entry: { action: 'money_in', amount: 500000, party: 'ramesh' } }],
  ['Ramesh ne 5000 diye', { kind: 'entry', entry: { action: 'money_in', amount: 500000, party: 'ramesh' } }],
  ['received 5k from Sita via gpay', { kind: 'entry', entry: { action: 'money_in', amount: 500000, party: 'sita', how: 'upi' } }],
  ['recieved 1.5 lakh from Sita Traders on 5 oct', { kind: 'entry', entry: { action: 'money_in', amount: 15000000, party: 'sita traders', date: '2026-10-05' } }],
  ['sold 3 bags to Sita for 900', { kind: 'entry', entry: { action: 'sale', qtyMilli: 3000, what: 'bags', party: 'sita', amount: 90000 } }],
  ['sold 2 chairs to Ramesh', { kind: 'entry', entry: { action: 'sale', qtyMilli: 2000, what: 'chairs', party: 'ramesh', amount: undefined } }],
  ['Sita ko 3 bag 900 mein beche', { kind: 'entry', entry: { action: 'sale', qtyMilli: 3000, what: 'bag', party: 'sita', amount: 90000 } }],
  ['sold for 1500 cash', { kind: 'entry', entry: { action: 'sale', amount: 150000, how: 'cash', qtyMilli: undefined } }],
  ['bought 10 bags from Mohan for 5000', { kind: 'entry', entry: { action: 'purchase', qtyMilli: 10000, what: 'bags', party: 'mohan', amount: 500000 } }],
  ['Mohan se 20 kg chawal kharida 1800 mein', { kind: 'entry', entry: { action: 'purchase', qtyMilli: 20000, what: 'chawal', party: 'mohan', amount: 180000 } }],
  // ---- review (PR #98): directions, prices of one, units, compound amounts, not-entries ----
  ['Ramesh ko 5000 bheja', { kind: 'entry', entry: { action: 'money_out', amount: 500000, party: 'ramesh' } }],
  ['Ramesh ne 5000 bheja', { kind: 'entry', entry: { action: 'money_in', amount: 500000, party: 'ramesh' } }],
  ['Ramesh se 5000 liya', { kind: 'entry', entry: { action: 'money_in', amount: 500000, party: 'ramesh' } }],
  ['Mohan se maal liya 3000', { kind: 'entry', entry: { action: 'purchase', amount: 300000, party: 'mohan' } }],
  ['Ramesh ko 5000 de diya', { kind: 'entry', entry: { action: 'money_out', amount: 500000, party: 'ramesh', what: undefined } }],
  ['Ramesh paid me 5000', { kind: 'entry', entry: { action: 'money_in', amount: 500000, party: 'ramesh' } }],
  ['Sita paid 2000 by upi', { kind: 'entry', entry: { action: 'money_in', amount: 200000, party: 'sita', how: 'upi' } }],
  ['I paid Ramesh 5000', { kind: 'entry', entry: { action: 'money_out', amount: 500000, party: 'ramesh' } }],
  ['electricity paid 2000', { kind: 'entry', entry: { action: 'money_out', amount: 200000, what: 'electricity', party: undefined } }],
  ['paid rent 2,500 by UPI', { kind: 'entry', entry: { action: 'money_out', amount: 250000, what: 'rent', how: 'upi' } }],
  ['piad rent 2500', { kind: 'entry', entry: { action: 'money_out', amount: 250000, what: 'rent' } }],
  ['sold to Ramesh 3 bags 900 each', { kind: 'entry', entry: { action: 'sale', qtyMilli: 3000, what: 'bags', party: 'ramesh', amount: 90000, perUnit: true } }],
  ['sold 3 bags @ 300 to Sita', { kind: 'entry', entry: { action: 'sale', qtyMilli: 3000, amount: 30000, perUnit: true } }],
  ['sold 3 bags to Sita for 900 total', { kind: 'entry', entry: { action: 'sale', qtyMilli: 3000, amount: 90000, perUnit: undefined } }],
  ['bought 10 kg rice for 500', { kind: 'entry', entry: { action: 'purchase', qtyMilli: 10000, what: 'rice', amount: 50000 } }],
  ['received 2 lakh 50 thousand', { kind: 'entry', entry: { action: 'money_in', amount: 25000000 } }],
  ['paid ₹2,500 rent', { kind: 'entry', entry: { action: 'money_out', amount: 250000, what: 'rent' } }],
  ['paid 2.5k for petrol', { kind: 'entry', entry: { action: 'money_out', amount: 250000, what: 'petrol' } }],
  ['receive 5000 from ramesh tomorrow', { kind: 'entry', entry: { action: 'money_in', amount: 500000, party: 'ramesh', date: '2026-10-15' } }],
  ['paid 12.345 to Ramesh', { kind: 'unknown' }],
  ['5000 Ramesh', { kind: 'unknown' }],
  ['total I received from Sita in 2025', { kind: 'unknown' }],
  ['received from Ramesh last 30 days', { kind: 'unknown' }],
  ['show me what I sold to Ramesh for 500', { kind: 'figure', measure: 'sales' }],
  // ---- not entries / not understood ----
  ['how much did I pay for rent this month', { kind: 'figure', measure: 'expenses' }],
  ['did I receive 5000 from Ramesh?', { kind: 'unknown' }],
  ['tell me a joke', { kind: 'unknown' }],
  ['hello', { kind: 'unknown' }],
  ['paid rent', { kind: 'unknown' }]
]

describe('Ask Total corpus', () => {
  it('has at least 60 phrasings', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(60)
  })

  for (const [text, want] of CORPUS) {
    it(`“${text}”`, () => {
      const got = classify(text, TODAY) as unknown as Record<string, unknown>
      const check = (have: Record<string, unknown> | undefined, exp: Record<string, unknown>, path: string): void => {
        for (const [k, v] of Object.entries(exp)) {
          if (v !== null && typeof v === 'object') check(have?.[k] as Record<string, unknown> | undefined, v as Record<string, unknown>, `${path}${k}.`)
          else expect(have?.[k], `${path}${k}`).toEqual(v)
        }
      }
      check(got, want, '')
    })
  }
})

describe('Ask Total normalising', () => {
  it('reads Hinglish periods and measures into English', () => {
    expect(normalise('kitna profit hua is mahine').q).toBe('how much profit hua this month')
    expect(normalise('pichle mahine ka munafa').q).toBe('last month ka profit')
  })
  it('fixes a one-letter typo in a known word, never in a name', () => {
    expect(normalise('porfit').q).toBe('profit')
    expect(normalise('ramesh').q).toBe('ramesh')
  })
  it('never reads a Devanagari syllable inside a word as a particle', () => {
    expect(normalise('पैसे').q).toBe('पैसे')
  })
  it('a named month later than today means last year’s', () => {
    expect(periodOf('sales in march', TODAY)).toMatchObject({ from: '2026-03-01', to: '2026-03-31' })
  })
})
