// Typed client for the fixed-asset register (WP 3.6) — the fa:* channels in
// src/main/ipcFixedAssets.ts. Kept beside client.ts so the register's surface stays in one place.
import { call } from './client'
import type {
  AssetAdditionInput, AssetAdditionRow, AssetGroupInput, AssetGroupRow, AssetSchedule, CaClassInput, CaClassRow,
  DepreciationPreview, DepreciationPreviewRow, DepreciationRunRow, DepreciationYearStatus, DisposalInput, DisposalPreview,
  FixedAssetInput, FixedAssetRow, ItBlockInput, ItBlockOpeningInput, ItBlockRateInput, ItBlockRateRow, ItBlockRow,
  ItStatement, PurchaseCandidate
} from '@shared/fixedAssets'

export const faApi = {
  classes: () => call<CaClassRow[]>('fa:classes'),
  classSave: (data: CaClassInput, id?: number) => call<CaClassRow>('fa:classSave', { data, id }),
  classDelete: (id: number) => call<null>('fa:classDelete', { id }),
  blocks: () => call<ItBlockRow[]>('fa:blocks'),
  blockSave: (data: ItBlockInput, id?: number) => call<ItBlockRow>('fa:blockSave', { data, id }),
  blockDelete: (id: number) => call<null>('fa:blockDelete', { id }),
  blockRateSave: (data: ItBlockRateInput, id?: number) => call<ItBlockRateRow>('fa:blockRateSave', { data, id }),
  blockRateDelete: (id: number) => call<null>('fa:blockRateDelete', { id }),
  blockOpeningSet: (data: ItBlockOpeningInput) => call<null>('fa:blockOpeningSet', data),
  blockOpeningClear: (blockId: number, fyStartYear: number) => call<null>('fa:blockOpeningClear', { blockId, fyStartYear }),
  groups: () => call<AssetGroupRow[]>('fa:groups'),
  groupSave: (data: AssetGroupInput, id?: number) => call<AssetGroupRow>('fa:groupSave', { data, id }),
  groupDelete: (id: number) => call<null>('fa:groupDelete', { id }),

  list: (asOn: string) => call<FixedAssetRow[]>('fa:list', { asOn }),
  get: (id: number, asOn: string) => call<FixedAssetRow>('fa:get', { id, asOn }),
  save: (data: FixedAssetInput, id?: number) => call<FixedAssetRow>('fa:save', { data, id }),
  remove: (id: number) => call<null>('fa:delete', { id }),
  additionSave: (data: AssetAdditionInput, id?: number) => call<AssetAdditionRow>('fa:additionSave', { data, id }),
  additionDelete: (id: number) => call<null>('fa:additionDelete', { id }),
  purchaseCandidates: (from: string, to: string) => call<PurchaseCandidate[]>('fa:purchaseCandidates', { from, to }),
  fromVoucher: (id: number) => call<PurchaseCandidate | null>('fa:fromVoucher', { id }),

  runPreview: (from: string, to: string) => call<DepreciationPreview>('fa:runPreview', { from, to }),
  runPost: (from: string, to: string) => call<DepreciationRunRow>('fa:runPost', { from, to }),
  runs: () => call<DepreciationRunRow[]>('fa:runs'),
  runLines: (id: number) => call<DepreciationPreviewRow[]>('fa:runLines', { id }),
  yearStatus: (fyStartYear: number) => call<DepreciationYearStatus>('fa:yearStatus', { fyStartYear }),

  disposalPreview: (data: DisposalInput) => call<DisposalPreview>('fa:disposalPreview', data),
  dispose: (data: DisposalInput) => call<{ asset: FixedAssetRow; voucherId: number; preview: DisposalPreview }>('fa:dispose', data),

  schedule: (from: string, to: string) => call<AssetSchedule>('fa:schedule', { from, to }),
  itStatement: (fyStartYear: number) => call<ItStatement>('fa:itStatement', { fyStartYear })
}
