import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const outputPath = resolve(process.argv[2] ?? resolve(root, 'dist/legal-risk-acceptance.json'))
const productVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
const documents = [
  ['privacy', 'site/app/privacy/page.tsx'],
  ['terms', 'site/app/terms/page.tsx'],
  ['security', 'site/app/security/page.tsx'],
  ['commercial-policy', 'docs/COMMERCIAL_POLICY.md'],
].map(([id, relativePath]) => ({
  id,
  sha256: createHash('sha256').update(readFileSync(resolve(root, relativePath))).digest('hex'),
  result: 'pending',
}))

const packet = {
  schema: 1,
  kind: 'legal-risk',
  status: 'pending',
  productVersion,
  approvedAt: '',
  approvers: [],
  releaseChannel: 'free-public-beta',
  freeOfCharge: true,
  directSalesEnabled: false,
  significantPaidMarketingEnabled: false,
  notQualifiedLegalReview: true,
  ownerAcceptsUnreviewedLegalRisk: false,
  qualifiedReviewRequiredBeforePaidSales: true,
  documents,
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(packet, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ ok: true, outputPath, productVersion, documents: documents.length }))
