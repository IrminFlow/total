/**
 * CBIC/GSTN Unit Quantity Codes (UQC) — the closed enum the GSTR-1 offline tool,
 * e-invoice (NIC) and e-way bill systems accept for quantity units. Any other code is
 * rejected by the portal, so unit masters validate against this list and `toUqc`
 * normalises common free-text aliases before export.
 *
 * Source: the UQC master bundled with the GSTN GSTR-1 offline tool / NIC e-invoice
 * master codes list. Note: 'LTR' (LITRES) IS part of the published master — an earlier
 * audit flagged it as invalid, but the CBIC list carries LTR-LITRES alongside
 * KLR-KILOLITRE and MLT-MILILITRE.
 */
export const UQC_CODES: Record<string, string> = {
  BAG: 'BAGS',
  BAL: 'BALE',
  BDL: 'BUNDLES',
  BKL: 'BUCKLES',
  BOU: 'BILLION OF UNITS',
  BOX: 'BOX',
  BTL: 'BOTTLES',
  BUN: 'BUNCHES',
  CAN: 'CANS',
  CBM: 'CUBIC METERS',
  CCM: 'CUBIC CENTIMETERS',
  CMS: 'CENTIMETERS',
  CTN: 'CARTONS',
  DOZ: 'DOZENS',
  DRM: 'DRUMS',
  GGK: 'GREAT GROSS',
  GMS: 'GRAMMES',
  GRS: 'GROSS',
  GYD: 'GROSS YARDS',
  KGS: 'KILOGRAMS',
  KLR: 'KILOLITRE',
  KME: 'KILOMETRE',
  LTR: 'LITRES',
  MLT: 'MILILITRE',
  MTR: 'METERS',
  MTS: 'METRIC TON',
  NOS: 'NUMBERS',
  OTH: 'OTHERS',
  PAC: 'PACKS',
  PCS: 'PIECES',
  PRS: 'PAIRS',
  QTL: 'QUINTAL',
  ROL: 'ROLLS',
  SET: 'SETS',
  SQF: 'SQUARE FEET',
  SQM: 'SQUARE METERS',
  SQY: 'SQUARE YARDS',
  TBS: 'TABLETS',
  TGM: 'TEN GROSS',
  THD: 'THOUSANDS',
  TON: 'TONNES',
  TUB: 'TUBES',
  UGS: 'US GALLONS',
  UNT: 'UNITS',
  YDS: 'YARDS'
}

/** True when `code` (any case) is a valid portal UQC. */
export function isUqc(code: string): boolean {
  return code.trim().toUpperCase() in UQC_CODES
}

/** Common unit-symbol/free-text aliases → their portal UQC. Keys are uppercased inputs. */
const ALIASES: Record<string, string> = {
  L: 'LTR',
  LT: 'LTR',
  LIT: 'LTR',
  LITRE: 'LTR',
  LITRES: 'LTR',
  LITER: 'LTR',
  ML: 'MLT',
  KG: 'KGS',
  KILO: 'KGS',
  KILOGRAM: 'KGS',
  KILOGRAMS: 'KGS',
  G: 'GMS',
  GM: 'GMS',
  GRAM: 'GMS',
  GRAMS: 'GMS',
  M: 'MTR',
  MT: 'MTS',
  METER: 'MTR',
  METRE: 'MTR',
  METERS: 'MTR',
  METRES: 'MTR',
  KM: 'KME',
  CM: 'CMS',
  NO: 'NOS',
  NUM: 'NOS',
  NUMBER: 'NOS',
  NUMBERS: 'NOS',
  PC: 'PCS',
  PIECE: 'PCS',
  PIECES: 'PCS',
  DZ: 'DOZ',
  DOZEN: 'DOZ',
  PAIR: 'PRS',
  PAIRS: 'PRS',
  PKT: 'PAC',
  PACK: 'PAC',
  PACKS: 'PAC',
  CARTON: 'CTN',
  CARTONS: 'CTN',
  BOTTLE: 'BTL',
  BOTTLES: 'BTL',
  BOXES: 'BOX',
  ROLL: 'ROL',
  ROLLS: 'ROL',
  SETS: 'SET',
  SQFT: 'SQF',
  SQMT: 'SQM',
  SQM2: 'SQM',
  TONNE: 'TON',
  TONNES: 'TON',
  TN: 'TON',
  QUINTAL: 'QTL',
  UNIT: 'UNT',
  UNITS: 'UNT',
  YD: 'YDS',
  YARD: 'YDS',
  YARDS: 'YDS'
}

export interface UqcResult {
  uqc: string
  /** True when the input wasn't a valid UQC or known alias and fell back to 'OTH'. */
  fallback: boolean
}

/**
 * Map a unit symbol/name to its portal UQC: exact codes pass through, known aliases are
 * translated, anything else falls back to 'OTH' with `fallback: true` so callers can warn.
 */
export function toUqc(unit: string): UqcResult {
  const u = unit.trim().toUpperCase()
  if (u in UQC_CODES) return { uqc: u, fallback: false }
  const alias = ALIASES[u]
  if (alias) return { uqc: alias, fallback: false }
  return { uqc: 'OTH', fallback: true }
}
