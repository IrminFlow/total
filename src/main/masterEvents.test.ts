import { describe, expect, it } from 'vitest'
import { AUDIT_ENTITIES } from '@shared/auditEntities'
import { changedEntitiesOf, FEATURE_DATA_ENTITIES, MASTER_ENTITIES, masterEntitiesOf } from './masterEvents'

describe('masterEntitiesOf (to-do §4)', () => {
  it('a master write names its masters; reads and voucher-only writes name none', () => {
    expect(masterEntitiesOf('master:stockItems:create')).toEqual(['stockItem'])
    expect(masterEntitiesOf('master:stockItems:quickCreate')).toEqual(['stockItem', 'priceLevel'])
    expect(masterEntitiesOf('stock:labelsHtml')).toEqual([])
    expect(masterEntitiesOf('voucher:save')).toEqual([])
    expect(masterEntitiesOf('no:such:channel')).toEqual([])
  })
  it('every master entity is a real audit entity', () => {
    for (const e of MASTER_ENTITIES) expect(AUDIT_ENTITIES).toContain(e)
  })
})

describe('changedEntitiesOf (feature cleanup)', () => {
  it('a write that can add a hidden feature’s data also names features; reads never do', () => {
    expect(changedEntitiesOf('voucher:save')).toEqual(['features'])
    expect(changedEntitiesOf('cc:save')).toContain('features')
    expect(changedEntitiesOf('master:stockItems:create')).toEqual(['stockItem'])
    expect(changedEntitiesOf('stock:labelsHtml')).toEqual([])
  })
  it('every feature-data entity is a real audit entity', () => {
    for (const e of FEATURE_DATA_ENTITIES) expect(AUDIT_ENTITIES).toContain(e)
  })
})
