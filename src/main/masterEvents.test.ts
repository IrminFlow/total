import { describe, expect, it } from 'vitest'
import { AUDIT_ENTITIES } from '@shared/auditEntities'
import { MASTER_ENTITIES, masterEntitiesOf } from './masterEvents'

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
