// Pure test (plain-Node vitest): the generated voucher JSON schema doc must cover every field of
// the live zod schema, and the committed agent-skill/voucher.schema.json must match the generator
// exactly — regenerate with `node scripts/gen-voucher-schema.mjs` after changing voucher shapes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { voucherInputSchema } from '@shared/schemas'
import { voucherJsonSchema } from './schemaDoc'

interface Doc {
  properties: Record<string, { description?: string; type?: string | string[] }>
  required: string[]
}

describe('voucherJsonSchema', () => {
  it('documents every top-level field of voucherInputSchema (no silent drift)', () => {
    const doc = voucherJsonSchema() as unknown as Doc
    const schemaKeys = Object.keys(voucherInputSchema.shape)
    expect(Object.keys(doc.properties).sort()).toEqual(schemaKeys.sort())
    for (const key of schemaKeys) {
      expect(doc.properties[key]?.description, `field '${key}' needs a FIELD_DOCS entry`).toBeTruthy()
      expect(doc.properties[key]?.type, `field '${key}' walked to an empty node — extend the zod walk`).toBeTruthy()
    }
  })

  it('marks the actually-required fields and the balance rule', () => {
    const doc = voucherJsonSchema() as unknown as Doc & { description: string }
    expect(doc.required.sort()).toEqual(['date', 'lines', 'voucherTypeId'])
    expect(doc.description).toContain('INTEGER PAISE')
    expect(doc.description).toContain('Debits must equal credits')
  })

  it('matches the committed agent-skill/voucher.schema.json byte for byte', () => {
    // Normalize CRLF: Windows checkouts may rewrite the committed file's line endings
    // (.gitattributes pins LF now, but stay robust) — the guarantee is content, not EOL flavor.
    const committed = readFileSync(join(__dirname, '..', '..', '..', 'agent-skill', 'voucher.schema.json'), 'utf8').replace(/\r\n/g, '\n')
    expect(committed).toBe(JSON.stringify(voucherJsonSchema(), null, 2) + '\n')
  })
})
