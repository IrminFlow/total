// IPC channels for the fixed-asset register (WP 3.6). Registered from ipc.ts with its `handle`
// (role gate + { ok, data | error } envelope); every payload is Zod-parsed here.
import { z } from 'zod'
import type { DB } from './db/connection'
import type { Role } from './services/roles'
import * as fa from './services/fixedAssets'
import { isoDate } from '@shared/schemas'
import {
  assetAdditionInputSchema, assetGroupInputSchema, caClassInputSchema, depreciationPeriodSchema, disposalInputSchema,
  fixedAssetInputSchema, itBlockInputSchema, itBlockOpeningInputSchema, itBlockRateInputSchema, itStatementQuerySchema,
  scheduleQuerySchema
} from '@shared/fixedAssets'

type Handle = (channel: string, fn: (payload: unknown) => unknown, minRole?: Role) => void

const idSchema = z.object({ id: z.number().int().positive() })
const withId = <T extends z.ZodTypeAny>(schema: T) => z.object({ id: z.number().int().positive().optional(), data: schema })
const asOnSchema = z.object({ asOn: isoDate })

export function registerFixedAssetIpc(handle: Handle, db: () => DB): void {
  // Masters — statutory tables are owner-edited (like tds:rateSave); groups by accountants.
  handle('fa:classes', () => fa.listClasses(db()), 'viewer')
  handle('fa:classSave', (p) => {
    const { id, data } = withId(caClassInputSchema).parse(p)
    return fa.saveClass(db(), data, id)
  }, 'owner')
  handle('fa:classDelete', (p) => fa.deleteClass(db(), idSchema.parse(p).id), 'owner')
  handle('fa:blocks', () => fa.listBlocks(db()), 'viewer')
  handle('fa:blockSave', (p) => {
    const { id, data } = withId(itBlockInputSchema).parse(p)
    return fa.saveBlock(db(), data, id)
  }, 'owner')
  handle('fa:blockDelete', (p) => fa.deleteBlock(db(), idSchema.parse(p).id), 'owner')
  handle('fa:blockRateSave', (p) => {
    const { id, data } = withId(itBlockRateInputSchema).parse(p)
    return fa.saveBlockRate(db(), data, id)
  }, 'owner')
  handle('fa:blockRateDelete', (p) => fa.deleteBlockRate(db(), idSchema.parse(p).id), 'owner')
  handle('fa:blockOpeningSet', (p) => fa.setBlockOpening(db(), itBlockOpeningInputSchema.parse(p)))
  handle('fa:blockOpeningClear', (p) => {
    const { blockId, fyStartYear } = z.object({ blockId: z.number().int().positive(), fyStartYear: z.number().int() }).parse(p)
    return fa.clearBlockOpening(db(), blockId, fyStartYear)
  })
  handle('fa:groups', () => fa.listAssetGroups(db()), 'viewer')
  handle('fa:groupSave', (p) => {
    const { id, data } = withId(assetGroupInputSchema).parse(p)
    return fa.saveAssetGroup(db(), data, id)
  })
  handle('fa:groupDelete', (p) => fa.deleteAssetGroup(db(), idSchema.parse(p).id))

  // Register
  handle('fa:list', (p) => fa.listAssets(db(), asOnSchema.parse(p).asOn), 'viewer')
  handle('fa:get', (p) => {
    const { id, asOn } = z.object({ id: z.number().int().positive(), asOn: isoDate }).parse(p)
    return fa.getAsset(db(), id, asOn)
  }, 'viewer')
  handle('fa:save', (p) => {
    const { id, data } = withId(fixedAssetInputSchema).parse(p)
    return fa.saveAsset(db(), data, id)
  })
  handle('fa:delete', (p) => fa.deleteAsset(db(), idSchema.parse(p).id))
  handle('fa:additionSave', (p) => {
    const { id, data } = withId(assetAdditionInputSchema).parse(p)
    return fa.saveAddition(db(), data, id)
  })
  handle('fa:additionDelete', (p) => fa.deleteAddition(db(), idSchema.parse(p).id))
  handle('fa:purchaseCandidates', (p) => {
    const { from, to } = depreciationPeriodSchema.parse(p)
    return fa.purchaseCandidates(db(), from, to)
  }, 'viewer')
  handle('fa:fromVoucher', (p) => fa.candidateFromVoucher(db(), idSchema.parse(p).id), 'viewer')

  // Depreciation
  handle('fa:runPreview', (p) => {
    const { from, to } = depreciationPeriodSchema.parse(p)
    return fa.previewRun(db(), from, to)
  }, 'viewer')
  handle('fa:runPost', (p) => {
    const { from, to } = depreciationPeriodSchema.parse(p)
    return fa.postRun(db(), from, to)
  })
  handle('fa:runs', () => fa.listRuns(db()), 'viewer')
  handle('fa:runLines', (p) => fa.runLines(db(), idSchema.parse(p).id), 'viewer')
  handle('fa:yearStatus', (p) => fa.yearStatus(db(), itStatementQuerySchema.parse(p).fyStartYear), 'viewer')

  // Disposal
  handle('fa:disposalPreview', (p) => fa.previewDisposal(db(), disposalInputSchema.parse(p)), 'viewer')
  handle('fa:dispose', (p) => fa.disposeAsset(db(), disposalInputSchema.parse(p)))

  // Reports
  handle('fa:schedule', (p) => {
    const { from, to } = scheduleQuerySchema.parse(p)
    return fa.assetSchedule(db(), from, to)
  }, 'viewer')
  handle('fa:itStatement', (p) => fa.itStatement(db(), itStatementQuerySchema.parse(p).fyStartYear), 'viewer')
}
