/**
 * Approximate road distance between two Indian PIN codes, for the e-way bill's
 * `transDistance` field (see `distanceKm` on EdocInvoice in gst/edocs.ts, which is
 * serialised as `transDistance` in buildEwbBill).
 *
 * WHY THIS EXISTS, AND WHY IT IS ONLY AN ESTIMATE
 * ----------------------------------------------
 * The e-way bill's validity is a function of the distance declared on it (broadly one day
 * per 200 km for regular cargo). A user typing the distance by hand either shortens the
 * validity — and the consignment expires in transit — or lengthens it, which the department
 * reads as an inflated declaration. So a starting number is worth having.
 *
 * Total is fully offline and does not call NIC's live distance service. India Post's official
 * OGD directory is licence-clean, but its office coordinates still are not NIC's proprietary
 * motorable-route calculation and embedding the full changing directory here would not make
 * this an official distance. What we can do honestly is resolve the PIN to the *postal
 * sorting district* — the first three digits — and use an approximate coordinate for that
 * district's headquarters town. That is the whole of the claim being made here. It is not a
 * geocode of the address, it is a geocode of a sorting office's town, and the answer is wrong
 * by however far the actual pickup and drop points sit from those two towns.
 *
 * The NIC portal computes its own PIN-to-PIN distance. Its current documentation applies a 10%
 * upper grace and makes the portal result authoritative; API documentation also accepts zero as
 * a request to substitute NIC's stored distance. This module is only a pre-entry hint, never a
 * substitute. `PIN_DISTANCE_DISCLAIMER` is printed verbatim next to every result.
 *
 * WHERE THE NUMBERS CAME FROM  — // VERIFY: the whole table below is approximate.
 * Three classes of coordinate, none of them surveyed:
 *   1. `DISTRICT_COORDS` — three-digit sorting districts we are confident about: the metros,
 *      the state capitals and the larger industrial towns. Coordinates are the commonly cited
 *      city-centre latitude/longitude for that town (the kind of figure that agrees across
 *      general references to two decimal places, ~1 km). Rounded to 4 decimals.
 *   2. `SUBREGION_COORDS` — every allotted two-digit postal sub-region, used when the three-digit
 *      district is not in class 1. The coordinate is a rough geographic middle of the towns
 *      that sub-region covers, eyeballed from the districts it contains, not computed from a
 *      population-weighted centroid. Errors of 50-100 km inside a large circle are expected.
 *   3. Nothing else. An unallotted or malformed PIN returns null rather than a guess. There is
 *      no fallback to a state centroid and no fallback to "somewhere in India": a confidently
 *      wrong distance on a statutory document is worse than an absent one.
 * The ranges were checked on 2026-08-28 against the Department of Posts' OGD PIN directory
 * (resource updated 2025-10-03): first digit is the postal region, first two the sub-region and
 * first three the sorting district. 9x Army Postal Service PINs are deliberately not located.
 *
 * No money is involved anywhere in this module, so the integer-paise rule does not apply.
 * Distances are ordinary numbers of kilometres, and are rounded to whole kilometres only at
 * the boundary — `estimateEwayDistanceKm` — because the e-way bill portal's distance field
 * takes whole kilometres and nothing finer would survive being typed into it anyway.
 */

export interface PinPoint {
  lat: number
  lon: number
}

export interface PinLocation extends PinPoint {
  /** 'district' = matched a three-digit sorting district; 'subregion' = only the first two digits. */
  precision: 'district' | 'subregion'
}

export interface EwayDistanceEstimate {
  /** Whole kilometres — the portal's distance field takes no decimals. */
  km: number
  /** Human-readable account of what was actually resolved, for showing under the field. */
  basis: string
  /** Always true. There is no path through this module that yields a surveyed distance. */
  approximate: true
}

/**
 * Road distance / great-circle distance. A road bends around rivers, hills and towns, so it is
 * always longer than the straight line; transport planning conventionally calls the ratio the
 * "circuity factor" or "detour index" and puts it at roughly 1.2-1.3 for inter-city road travel,
 * with 1.25 the usual working figure. That convention is the entire justification for this
 * constant — it is an assumption, not a measurement, and it is systematically wrong for a
 * mountain route (too low) and for a route along a straight national highway (too high).
 */
export const ROAD_CIRCUITY_FACTOR = 1.25

/**
 * Floor for this estimate. Zero has a distinct API meaning: ask NIC to substitute its own stored
 * distance. This offline suggestion never impersonates that live lookup, so two PINs resolving
 * to one approximate point are shown as a conservative non-zero hint and must still be checked.
 */
export const MIN_ESTIMATED_KM = 1

/** Printed verbatim in the UI next to any distance this module produces. */
export const PIN_DISTANCE_DISCLAIMER =
  'This distance is an estimate, not a measurement. It is the straight-line distance between ' +
  'approximate reference points for the two PIN codes’ postal districts or sub-regions, increased by a fixed allowance ' +
  'for roads not running straight. It does not know your actual pickup or delivery address, ' +
  'the route, or the roads. Check it against the distance the e-way bill portal calculates ' +
  'before you file, and correct it if it differs — the transporter’s real route is ' +
  'what governs the validity of the bill, and an understated distance can expire a consignment ' +
  'in transit.'

/**
 * Two-digit postal sub-regions. Key = first two digits of the PIN. Every civil prefix present in
 * the Department of Posts OGD directory appears; gaps are deliberately absent. 90-99 is the
 * Army Postal Service, whose
 * field post offices have no fixed location at all and must never be given one here.
 *
 * // APPROXIMATE: rough geographic middles of the districts each sub-region covers. Class 2 above.
 */
const SUBREGION_COORDS: Record<string, PinPoint> = {
  // Region 1 — Delhi, Haryana, Punjab, Himachal, J&K, Ladakh, Chandigarh
  '11': { lat: 28.63, lon: 77.22 }, // Delhi
  '12': { lat: 28.5, lon: 76.9 }, // Haryana south — Faridabad, Gurugram, Rohtak, Hisar
  '13': { lat: 29.9, lon: 76.9 }, // Haryana north — Karnal, Ambala, Panipat
  '14': { lat: 30.9, lon: 75.85 }, // Punjab central — Ludhiana, Jalandhar, Amritsar, Patiala
  '15': { lat: 30.2, lon: 74.95 }, // Punjab south-west — Bathinda, Ferozepur, Muktsar
  '16': { lat: 30.73, lon: 76.78 }, // Chandigarh and its Punjab hinterland
  '17': { lat: 31.3, lon: 77.0 }, // Himachal Pradesh
  '18': { lat: 32.85, lon: 74.95 }, // Jammu division
  '19': { lat: 34.08, lon: 74.8 }, // Kashmir division and Ladakh
  // Region 2 — Uttar Pradesh, Uttarakhand
  '20': { lat: 27.5, lon: 78.5 }, // Ghaziabad/Noida through to Kanpur
  '21': { lat: 25.5, lon: 81.5 }, // Prayagraj, Banda
  '22': { lat: 26.0, lon: 82.0 }, // Lucknow, Varanasi, Ayodhya belt
  '23': { lat: 25.2, lon: 82.9 }, // Mirzapur, Ghazipur, Sonbhadra
  '24': { lat: 29.0, lon: 78.6 }, // Bareilly, Moradabad, Saharanpur, Dehradun, Haridwar
  '25': { lat: 29.2, lon: 77.7 }, // Meerut, Muzaffarnagar
  '26': { lat: 28.5, lon: 79.6 }, // Sitapur, Pilibhit, Nainital, Kumaon
  '27': { lat: 26.8, lon: 83.3 }, // Gorakhpur, Basti, Deoria
  '28': { lat: 26.5, lon: 78.4 }, // Agra, Mathura, Jhansi
  // Region 3 — Rajasthan, Gujarat
  '30': { lat: 26.5, lon: 75.5 }, // Jaipur, Alwar, Ajmer
  '31': { lat: 24.9, lon: 74.4 }, // Udaipur, Bhilwara, Chittorgarh
  '32': { lat: 25.6, lon: 76.4 }, // Kota, Bharatpur, Sawai Madhopur
  '33': { lat: 28.2, lon: 74.5 }, // Bikaner, Sikar, Sri Ganganagar
  '34': { lat: 26.5, lon: 72.5 }, // Jodhpur, Barmer, Jaisalmer
  '36': { lat: 21.9, lon: 70.8 }, // Saurashtra — Rajkot, Bhavnagar, Junagadh
  '37': { lat: 23.24, lon: 69.67 }, // Kutch
  '38': { lat: 23.1, lon: 72.6 }, // Ahmedabad, Gandhinagar, north Gujarat
  '39': { lat: 21.5, lon: 73.0 }, // Vadodara, Surat, south Gujarat, Daman, Silvassa
  // Region 4 — Maharashtra, Goa, Madhya Pradesh, Chhattisgarh
  '40': { lat: 19.0, lon: 73.0 }, // Mumbai, Konkan, Goa
  '41': { lat: 18.0, lon: 74.5 }, // Pune, Solapur, Kolhapur, Satara
  '42': { lat: 20.2, lon: 74.3 }, // Thane, Nashik, Jalgaon, Dhule
  '43': { lat: 19.3, lon: 76.5 }, // Marathwada — Chhatrapati Sambhajinagar, Nanded
  '44': { lat: 20.6, lon: 78.5 }, // Vidarbha — Nagpur, Amravati, Chandrapur
  '45': { lat: 22.6, lon: 75.7 }, // Indore, Ujjain, Ratlam
  '46': { lat: 23.1, lon: 77.5 }, // Bhopal, Vidisha, Betul
  '47': { lat: 25.0, lon: 78.6 }, // Gwalior, Sagar, Chhatarpur, Morena
  '48': { lat: 23.4, lon: 80.2 }, // Jabalpur, Rewa, Satna, Chhindwara
  '49': { lat: 21.3, lon: 81.8 }, // Chhattisgarh — Raipur, Durg, Bilaspur, Bastar
  // Region 5 — Telangana, Andhra Pradesh, Karnataka
  '50': { lat: 17.6, lon: 78.8 }, // Telangana — Hyderabad, Warangal, Nizamabad
  '51': { lat: 14.5, lon: 78.5 }, // Rayalaseema — Kurnool, Kadapa, Tirupati
  '52': { lat: 16.0, lon: 80.3 }, // Vijayawada, Guntur, Nellore
  '53': { lat: 17.5, lon: 82.5 }, // Visakhapatnam, Godavari districts
  '56': { lat: 13.0, lon: 77.6 }, // Bengaluru and around
  '57': { lat: 13.2, lon: 75.8 }, // Mysuru, Mangaluru, Hassan, Udupi
  '58': { lat: 15.6, lon: 75.9 }, // Hubballi, Ballari, Kalaburagi, Vijayapura
  '59': { lat: 15.85, lon: 74.5 }, // Belagavi
  // Region 6 — Tamil Nadu, Kerala, Puducherry, Lakshadweep
  '60': { lat: 12.3, lon: 79.6 }, // Chennai, Villupuram, Cuddalore, Puducherry
  '61': { lat: 10.8, lon: 79.4 }, // Thanjavur delta — Kumbakonam, Nagapattinam
  '62': { lat: 10.0, lon: 78.4 }, // Trichy, Madurai, Tirunelveli, Kanyakumari
  '63': { lat: 11.8, lon: 78.4 }, // Salem, Vellore, Erode, Krishnagiri
  '64': { lat: 11.0, lon: 77.0 }, // Coimbatore, Tiruppur, Nilgiris
  '67': { lat: 11.6, lon: 75.8 }, // Malabar — Kozhikode, Kannur, Palakkad
  '68': { lat: 10.0, lon: 76.5 }, // Kochi, Thrissur, Kottayam, Lakshadweep
  '69': { lat: 8.9, lon: 76.7 }, // Thiruvananthapuram, Kollam
  // Region 7 — West Bengal, Odisha, North East, Andaman & Nicobar, Sikkim
  '70': { lat: 22.57, lon: 88.36 }, // Kolkata
  '71': { lat: 22.9, lon: 87.8 }, // Howrah, Hooghly, Bardhaman, Asansol
  '72': { lat: 22.5, lon: 87.2 }, // Medinipur, Bankura, Purulia
  '73': { lat: 25.5, lon: 88.4 }, // North Bengal — Malda, Siliguri, Jalpaiguri, Sikkim
  '74': { lat: 23.4, lon: 88.5 }, // Nadia, Murshidabad, 24 Parganas, Andaman
  '75': { lat: 20.7, lon: 85.4 }, // Coastal Odisha — Bhubaneswar, Cuttack, Balasore
  '76': { lat: 20.3, lon: 84.0 }, // South and west Odisha — Berhampur, Sambalpur, Koraput
  '77': { lat: 22.2, lon: 84.9 }, // Sundargarh, Rourkela
  '78': { lat: 26.4, lon: 92.5 }, // Assam
  '79': { lat: 25.0, lon: 93.2 }, // Meghalaya, Manipur, Mizoram, Nagaland, Tripura, Arunachal
  // Region 8 — Bihar, Jharkhand
  '80': { lat: 25.5, lon: 84.9 }, // Patna, Bhojpur, Nalanda
  '81': { lat: 24.9, lon: 87.0 }, // Bhagalpur, Munger, Deoghar, Dumka
  '82': { lat: 24.2, lon: 85.5 }, // Gaya, Sasaram, Dhanbad, Bokaro, Hazaribagh
  '83': { lat: 22.9, lon: 85.7 }, // Jamshedpur, Ranchi, Singhbhum
  '84': { lat: 26.1, lon: 85.4 }, // North Bihar — Muzaffarpur, Darbhanga, Motihari
  '85': { lat: 25.8, lon: 86.9 } // Kosi and Seemanchal — Begusarai, Saharsa, Purnia
}

/**
 * Three-digit sorting districts we are confident about: metros, state capitals, and the larger
 * industrial towns. Anything not listed falls back to its sub-region, which is the honest thing to
 * do — a district we have not checked would otherwise be a made-up coordinate wearing the
 * 'district' precision label.
 *
 * // APPROXIMATE: commonly cited city-centre coordinates for the district's head town. Class 1 above.
 */
const DISTRICT_COORDS: Record<string, PinPoint> = {
  // Delhi NCR and the north
  '110': { lat: 28.6139, lon: 77.209 }, // Delhi
  '121': { lat: 28.4089, lon: 77.3178 }, // Faridabad
  '122': { lat: 28.4595, lon: 77.0266 }, // Gurugram
  '134': { lat: 30.69, lon: 76.85 }, // Panchkula
  '141': { lat: 30.901, lon: 75.8573 }, // Ludhiana
  '143': { lat: 31.634, lon: 74.8723 }, // Amritsar
  '144': { lat: 31.326, lon: 75.5762 }, // Jalandhar
  '147': { lat: 30.3398, lon: 76.3869 }, // Patiala
  '160': { lat: 30.7333, lon: 76.7794 }, // Chandigarh
  '171': { lat: 31.1048, lon: 77.1734 }, // Shimla
  '180': { lat: 32.7266, lon: 74.857 }, // Jammu
  '190': { lat: 34.0837, lon: 74.7973 }, // Srinagar
  '194': { lat: 34.1526, lon: 77.5771 }, // Leh
  // Uttar Pradesh, Uttarakhand
  '201': { lat: 28.5355, lon: 77.391 }, // Ghaziabad / Noida
  '208': { lat: 26.4499, lon: 80.3319 }, // Kanpur
  '211': { lat: 25.4358, lon: 81.8463 }, // Prayagraj
  '221': { lat: 25.3176, lon: 82.9739 }, // Varanasi
  '226': { lat: 26.8467, lon: 80.9462 }, // Lucknow
  '243': { lat: 28.367, lon: 79.4304 }, // Bareilly
  '248': { lat: 30.3165, lon: 78.0322 }, // Dehradun
  '250': { lat: 28.9845, lon: 77.7064 }, // Meerut
  '273': { lat: 26.7606, lon: 83.3732 }, // Gorakhpur
  '282': { lat: 27.1767, lon: 78.0081 }, // Agra
  '284': { lat: 25.4484, lon: 78.5685 }, // Jhansi
  // Rajasthan
  '302': { lat: 26.9124, lon: 75.7873 }, // Jaipur
  '305': { lat: 26.4499, lon: 74.6399 }, // Ajmer
  '313': { lat: 24.5854, lon: 73.7125 }, // Udaipur
  '324': { lat: 25.2138, lon: 75.8648 }, // Kota
  '334': { lat: 28.0229, lon: 73.3119 }, // Bikaner
  '342': { lat: 26.2389, lon: 73.0243 }, // Jodhpur
  // Gujarat
  '360': { lat: 22.3039, lon: 70.8022 }, // Rajkot
  '370': { lat: 23.242, lon: 69.6669 }, // Bhuj
  '380': { lat: 23.0225, lon: 72.5714 }, // Ahmedabad
  '382': { lat: 23.2156, lon: 72.6369 }, // Gandhinagar
  '390': { lat: 22.3072, lon: 73.1812 }, // Vadodara
  '395': { lat: 21.1702, lon: 72.8311 }, // Surat
  '396': { lat: 20.55, lon: 72.9 }, // Valsad / Daman / Silvassa
  // Maharashtra, Goa
  '400': { lat: 19.076, lon: 72.8777 }, // Mumbai
  '403': { lat: 15.4909, lon: 73.8278 }, // Panaji
  '411': { lat: 18.5204, lon: 73.8567 }, // Pune
  '416': { lat: 16.705, lon: 74.2433 }, // Kolhapur
  '421': { lat: 19.2437, lon: 73.1355 }, // Kalyan / Thane belt
  '422': { lat: 19.9975, lon: 73.7898 }, // Nashik
  '425': { lat: 21.0077, lon: 75.5626 }, // Jalgaon
  '431': { lat: 19.8762, lon: 75.3433 }, // Chhatrapati Sambhajinagar
  '440': { lat: 21.1458, lon: 79.0882 }, // Nagpur
  // Madhya Pradesh, Chhattisgarh
  '452': { lat: 22.7196, lon: 75.8577 }, // Indore
  '456': { lat: 23.1765, lon: 75.7885 }, // Ujjain
  '462': { lat: 23.2599, lon: 77.4126 }, // Bhopal
  '474': { lat: 26.2183, lon: 78.1828 }, // Gwalior
  '482': { lat: 23.1815, lon: 79.9864 }, // Jabalpur
  '490': { lat: 21.1938, lon: 81.3509 }, // Bhilai / Durg
  '492': { lat: 21.2514, lon: 81.6296 }, // Raipur
  '495': { lat: 22.0797, lon: 82.1409 }, // Bilaspur
  // Telangana, Andhra Pradesh
  '500': { lat: 17.385, lon: 78.4867 }, // Hyderabad
  '506': { lat: 17.9689, lon: 79.5941 }, // Warangal
  '515': { lat: 14.6819, lon: 77.6006 }, // Anantapur
  '517': { lat: 13.6288, lon: 79.4192 }, // Tirupati
  '518': { lat: 15.8281, lon: 78.0373 }, // Kurnool
  '520': { lat: 16.5062, lon: 80.648 }, // Vijayawada
  '522': { lat: 16.3067, lon: 80.4365 }, // Guntur
  '524': { lat: 14.4426, lon: 79.9865 }, // Nellore
  '530': { lat: 17.6868, lon: 83.2185 }, // Visakhapatnam
  '533': { lat: 16.9891, lon: 82.2475 }, // Kakinada
  // Karnataka
  '560': { lat: 12.9716, lon: 77.5946 }, // Bengaluru
  '570': { lat: 12.2958, lon: 76.6394 }, // Mysuru
  '575': { lat: 12.9141, lon: 74.856 }, // Mangaluru
  '580': { lat: 15.3647, lon: 75.124 }, // Hubballi-Dharwad
  '583': { lat: 15.1394, lon: 76.9214 }, // Ballari
  '585': { lat: 17.3297, lon: 76.8343 }, // Kalaburagi
  '590': { lat: 15.8497, lon: 74.4977 }, // Belagavi
  // Tamil Nadu, Puducherry
  '600': { lat: 13.0827, lon: 80.2707 }, // Chennai
  '605': { lat: 11.9416, lon: 79.8083 }, // Puducherry
  '613': { lat: 10.787, lon: 79.1378 }, // Thanjavur
  '620': { lat: 10.7905, lon: 78.7047 }, // Tiruchirappalli
  '625': { lat: 9.9252, lon: 78.1198 }, // Madurai
  '627': { lat: 8.7139, lon: 77.7567 }, // Tirunelveli
  '632': { lat: 12.9165, lon: 79.1325 }, // Vellore
  '636': { lat: 11.6643, lon: 78.146 }, // Salem
  '638': { lat: 11.341, lon: 77.7172 }, // Erode
  '641': { lat: 11.0168, lon: 76.9558 }, // Coimbatore
  // Kerala
  '673': { lat: 11.2588, lon: 75.7804 }, // Kozhikode
  '678': { lat: 10.7867, lon: 76.6548 }, // Palakkad
  '680': { lat: 10.5276, lon: 76.2144 }, // Thrissur
  '682': { lat: 9.9312, lon: 76.2673 }, // Kochi
  '686': { lat: 9.5916, lon: 76.5222 }, // Kottayam
  '691': { lat: 8.8932, lon: 76.6141 }, // Kollam
  '695': { lat: 8.5241, lon: 76.9366 }, // Thiruvananthapuram
  // West Bengal, Sikkim, Andaman
  '700': { lat: 22.5726, lon: 88.3639 }, // Kolkata
  '711': { lat: 22.5958, lon: 88.2636 }, // Howrah
  '713': { lat: 23.5204, lon: 87.3119 }, // Durgapur / Asansol
  '721': { lat: 22.346, lon: 87.232 }, // Kharagpur
  '734': { lat: 26.7271, lon: 88.3953 }, // Siliguri
  '737': { lat: 27.3389, lon: 88.6065 }, // Gangtok
  '744': { lat: 11.6234, lon: 92.7265 }, // Port Blair
  // Odisha
  '751': { lat: 20.2961, lon: 85.8245 }, // Bhubaneswar
  '753': { lat: 20.4625, lon: 85.883 }, // Cuttack
  '760': { lat: 19.315, lon: 84.7941 }, // Berhampur
  '768': { lat: 21.4669, lon: 83.9812 }, // Sambalpur
  '769': { lat: 22.2604, lon: 84.8536 }, // Rourkela
  // North East
  '781': { lat: 26.1445, lon: 91.7362 }, // Guwahati
  '786': { lat: 27.4728, lon: 94.912 }, // Dibrugarh
  '788': { lat: 24.8333, lon: 92.7789 }, // Silchar
  '791': { lat: 27.0844, lon: 93.6053 }, // Itanagar
  '793': { lat: 25.5788, lon: 91.8933 }, // Shillong
  '795': { lat: 24.817, lon: 93.9368 }, // Imphal
  '796': { lat: 23.7271, lon: 92.7176 }, // Aizawl
  '797': { lat: 25.6751, lon: 94.1086 }, // Kohima
  '799': { lat: 23.8315, lon: 91.2868 }, // Agartala
  // Bihar, Jharkhand
  '800': { lat: 25.5941, lon: 85.1376 }, // Patna
  '812': { lat: 25.2425, lon: 86.9842 }, // Bhagalpur
  '823': { lat: 24.7955, lon: 85.0002 }, // Gaya
  '826': { lat: 23.7957, lon: 86.4304 }, // Dhanbad
  '827': { lat: 23.6693, lon: 86.1511 }, // Bokaro
  '831': { lat: 22.8046, lon: 86.2029 }, // Jamshedpur
  '834': { lat: 23.3441, lon: 85.3096 }, // Ranchi
  '842': { lat: 26.1209, lon: 85.3647 }, // Muzaffarpur
  '846': { lat: 26.1542, lon: 85.8918 }, // Darbhanga
  '854': { lat: 25.7771, lon: 87.4753 } // Purnia
}

/**
 * Coordinate for a PIN, or null when we do not have an honest one.
 *
 * Null covers three cases, all of which the caller should treat the same way — ask the user for
 * the distance instead: the PIN is not six digits, the PIN's sub-region was never allotted by India
 * Post (00-10, 29, 35, 54, 55, 65, 66), or it is a 9x Army Postal Service number, whose field
 * post offices move.
 */
export function pinCoordinates(pin: string): PinLocation | null {
  if (typeof pin !== 'string') return null
  const trimmed = pin.trim()
  if (!/^\d{6}$/.test(trimmed)) return null

  const district = trimmed.slice(0, 3)
  const exact = DISTRICT_COORDS[district]
  if (exact) return { lat: exact.lat, lon: exact.lon, precision: 'district' }

  const subregion = SUBREGION_COORDS[trimmed.slice(0, 2)]
  if (subregion) return { lat: subregion.lat, lon: subregion.lon, precision: 'subregion' }

  return null
}

const EARTH_RADIUS_KM = 6371.0088 // IUGG mean radius; the sphere is an approximation of its own.
const toRad = (deg: number): number => (deg * Math.PI) / 180

/**
 * Great-circle distance in kilometres between two points, on a spherical earth. Not rounded —
 * rounding happens once, at the public boundary, so intermediate arithmetic does not compound.
 */
export function haversineKm(a: PinPoint, b: PinPoint): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

const precisionWord = (p: PinLocation['precision']): string =>
  p === 'district' ? 'postal district' : 'postal sub-region'

/**
 * Estimated road distance for an e-way bill, or null when either PIN cannot be resolved
 * honestly. Symmetric by construction: haversine is symmetric and nothing else depends on the
 * order of the arguments.
 */
export function estimateEwayDistanceKm(
  fromPin: string,
  toPin: string
): EwayDistanceEstimate | null {
  const from = pinCoordinates(fromPin)
  const to = pinCoordinates(toPin)
  if (!from || !to) return null

  const straight = haversineKm(from, to)
  // Round once, here, because the portal's distance field is whole kilometres.
  const km = Math.max(MIN_ESTIMATED_KM, Math.round(straight * ROAD_CIRCUITY_FACTOR))

  const worst: PinLocation['precision'] =
    from.precision === 'subregion' || to.precision === 'subregion' ? 'subregion' : 'district'
  const sameDistrict = fromPin.trim().slice(0, 3) === toPin.trim().slice(0, 3)

  const basis = sameDistrict
    ? `Both PIN codes are in ${precisionWord(worst)} ${fromPin.trim().slice(0, 3)}; ` +
      `shown as a ${MIN_ESTIMATED_KM} km non-zero hint, not NIC's live distance or a measurement`
    : `Straight line between ${precisionWord(from.precision)} ${fromPin.trim().slice(0, 3)} and ` +
      `${precisionWord(to.precision)} ${toPin.trim().slice(0, 3)}, ` +
      `× ${ROAD_CIRCUITY_FACTOR} for road circuity`

  return { km, basis, approximate: true }
}
