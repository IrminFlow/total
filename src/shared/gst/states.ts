/** GST state codes (first two digits of a GSTIN). */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  // 96/97 — non-state codes used for exports: 96 is "Other Country" (foreign buyers,
  // e-invoice Stcd/Pos for exports), 97 is "Other Territory". The e-way bill system maps
  // both to its own 99 "Other Country" code — see ewbStateCode in gst/edocs.ts.
  '96': 'Other Country',
  '97': 'Other Territory'
}

export function stateName(code: string): string | null {
  return GST_STATES[code] ?? null
}

/** Portal "pos" display string, e.g. "27-Maharashtra". */
export function posLabel(code: string): string {
  const name = stateName(code)
  return name ? `${code}-${name}` : code
}
