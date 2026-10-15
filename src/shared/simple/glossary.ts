// Plain-language glossary (WP 8.2): accounting term → the words simple mode uses, with a
// one-sentence explanation each, for the "Why?" popovers (kit/Why.tsx, Phase 10) and the
// "what does my accountant mean by …" help. Pure data + two helpers.
//
// Sources, merged (plan 2026-10-13, "Wording"):
//   audit = ~/.claude/total-orch/ux-audit.md "Jargon → plain-language proposals"
//   gpt   = the outside review (gpt-opinion.md §3 "Language")
// Where they differ the audit's shopkeeper wording wins in simple mode ("Money in" over "Money
// received"), and GPT's precision rules win everywhere: Total "prepares" a GST file, never
// "files" it; GST credit "awaits confirmation" until GSTR-2B shows it; Dr/Cr is never rendered
// as "money in / out" (wrong for most accounts) — it is hidden in everyday entry instead.
// Statutory names stay next to the explanation where the user will meet them ("GST on
// purchases you can claim (ITC)").
//
// `plain` and `explain` never use a word from the plan §1 banned list other than the entry's
// own term and aliases (glossary.test.ts). Hindi / Hinglish only where the word is natural.

import type { Language } from '../i18n'

export type GlossarySource = 'audit' | 'gpt'

export interface GlossaryEntry {
  /** The term as an accountant (or Tally) writes it. */
  term: string
  /** Other spellings that look up the same entry (case-insensitive). */
  aliases?: readonly string[]
  /** What simple mode says instead. */
  plain: string
  plainHi?: string
  plainHinglish?: string
  /** One sentence: what it is, in everyday words. */
  explain: string
  /** Gate polish: the explanation in Hindi / Hinglish (absent = the English one). */
  explainHi?: string
  explainHinglish?: string
  sources: readonly GlossarySource[]
}

export const GLOSSARY = {
  // ----- entries and screens -----
  voucher: {
    term: 'Voucher',
    aliases: ['Voucher entry', 'Vouchers'],
    plain: 'Entry',
    plainHi: 'एंट्री',
    plainHinglish: 'Entry',
    explain: 'One record of something that happened — a sale, a purchase, money in or money out.',
    explainHi: 'किसी हुए काम का एक रिकॉर्ड — एक बिक्री, एक खरीद, आया पैसा या गया पैसा।',
    explainHinglish: 'Kisi hue kaam ka ek record — ek sale, ek purchase, aaya paisa ya gaya paisa.',
    sources: ['audit', 'gpt']
  },
  gateway: {
    term: 'Gateway',
    aliases: ['Dashboard', 'Gateway of Tally'],
    plain: 'Home',
    plainHi: 'होम',
    explain: 'The first screen: today’s money, who owes you, and what needs doing.',
    sources: ['audit', 'gpt']
  },
  masters: {
    term: 'Masters',
    plain: 'Customers, suppliers, products and accounts',
    explain: 'The lists you set up once and pick from every day.',
    sources: ['audit', 'gpt']
  },
  dayBook: {
    term: 'Day book',
    aliases: ['Daybook'],
    plain: 'All entries',
    explain: 'Everything recorded, day by day.',
    sources: ['audit']
  },
  sales: {
    term: 'Sales voucher',
    aliases: ['Sales invoice', 'Sale'],
    plain: 'Sale bill',
    plainHi: 'बिक्री',
    plainHinglish: 'Sale bill',
    explain: 'The bill you give a customer for what they bought.',
    sources: ['audit']
  },
  purchase: {
    term: 'Purchase voucher',
    aliases: ['Purchase invoice', 'Purchase'],
    plain: 'Purchase bill',
    plainHi: 'खरीद',
    plainHinglish: 'Kharid',
    explain: 'The bill a supplier gave you for what you bought.',
    sources: ['audit']
  },
  receipt: {
    term: 'Receipt',
    aliases: ['Receipt voucher'],
    plain: 'Money in',
    plainHi: 'पैसे आए',
    plainHinglish: 'Paise aaye',
    explain: 'Money that came to you — a customer paying, a loan, or the owner putting money in.',
    explainHi: 'आपके पास आया पैसा — ग्राहक का भुगतान, कोई कर्ज़, या मालिक का डाला पैसा।',
    explainHinglish: 'Aapke paas aaya paisa — customer ka payment, koi loan, ya maalik ka daala paisa.',
    sources: ['audit']
  },
  payment: {
    term: 'Payment',
    aliases: ['Payment voucher'],
    plain: 'Money out',
    plainHi: 'पैसे गए',
    plainHinglish: 'Paise gaye',
    explain: 'Money you paid — to a supplier, for an expense, or taken out by the owner.',
    explainHi: 'आपने जो पैसा दिया — सप्लायर को, किसी खर्च के लिए, या मालिक ने निकाला।',
    explainHinglish: 'Aapne jo paisa diya — supplier ko, kisi kharche ke liye, ya maalik ne nikaala.',
    sources: ['audit']
  },
  contra: {
    term: 'Contra',
    aliases: ['Contra voucher'],
    plain: 'Move money',
    explain: 'Money moved between your own cash and bank accounts, like depositing cash in the bank.',
    sources: ['audit', 'gpt']
  },
  journal: {
    term: 'Journal',
    aliases: ['Journal voucher', 'Journal entry'],
    plain: 'Accounting adjustment',
    explain: 'A correction or transfer your accountant makes between accounts; everyday work never needs one.',
    sources: ['audit', 'gpt']
  },
  creditNote: {
    term: 'Credit note',
    plain: 'Sales return',
    explain: 'Reduces an earlier customer bill — goods came back or you gave a discount after billing.',
    explainHi: 'ग्राहक के पुराने बिल को कम करता है — माल वापस आया या बिल के बाद छूट दी।',
    explainHinglish: 'Customer ke purane bill ko kam karta hai — maal wapas aaya ya bill ke baad chhoot di.',
    sources: ['audit', 'gpt']
  },
  debitNote: {
    term: 'Debit note',
    plain: 'Purchase return',
    explain: 'Goods you sent back to a supplier, or an extra charge on an earlier bill — named by what it is for.',
    explainHi: 'सप्लायर को लौटाया माल, या पुराने बिल पर अतिरिक्त रकम — जिस काम का है उसी नाम से।',
    explainHinglish: 'Supplier ko lautaya maal, ya purane bill par extra rakam — jis kaam ka hai usi naam se.',
    sources: ['audit', 'gpt']
  },
  optionalVoucher: {
    term: 'Optional voucher',
    aliases: ['Memorandum voucher'],
    plain: 'Draft — not counted',
    explain: 'An entry kept aside that does not count in your accounts until you make it real.',
    sources: ['audit', 'gpt']
  },
  stockJournal: {
    term: 'Stock journal',
    plain: 'Move or correct stock',
    explain: 'Moves products between places or corrects quantities without a sale or purchase.',
    sources: ['audit']
  },
  physicalStock: {
    term: 'Physical stock',
    aliases: ['Physical stock voucher'],
    plain: 'Stock count',
    explain: 'What you actually counted on the shelf, so Total can correct its quantity.',
    sources: ['audit']
  },

  // ----- accounts and parties -----
  ledger: {
    term: 'Ledger',
    aliases: ['Ledgers', 'Ledger account', 'Party ledger'],
    plain: 'Account',
    plainHi: 'खाता',
    plainHinglish: 'Khata',
    explain: 'The running list of everything for one customer, supplier, bank or kind of income or expense.',
    explainHi: 'एक ग्राहक, सप्लायर, बैंक या आमदनी / खर्च की किस्म की हर बात की चलती सूची।',
    explainHinglish: 'Ek customer, supplier, bank ya aamdani / kharche ki kism ki har baat ki chalti list.',
    sources: ['audit', 'gpt']
  },
  party: {
    term: 'Party',
    plain: 'Customer or supplier',
    explain: 'Someone you sell to or buy from.',
    sources: ['gpt']
  },
  group: {
    term: 'Group',
    aliases: ['Under group', 'Account group', 'Groups'],
    plain: 'Kind of account',
    explain: 'Decides where an account shows in your statements; Total picks it from what the account is for.',
    sources: ['audit']
  },
  sundryDebtors: {
    term: 'Sundry Debtors',
    aliases: ['Debtors', 'Receivables'],
    plain: 'Customers who owe you',
    plainHi: 'लेना बाकी',
    plainHinglish: 'Lena baaki',
    explain: 'Customers who bought on credit and haven’t paid yet.',
    sources: ['audit', 'gpt']
  },
  sundryCreditors: {
    term: 'Sundry Creditors',
    aliases: ['Creditors', 'Payables'],
    plain: 'Suppliers you owe',
    plainHi: 'देना बाकी',
    plainHinglish: 'Dena baaki',
    explain: 'Suppliers whose bills you haven’t paid yet.',
    sources: ['audit', 'gpt']
  },
  directIndirect: {
    term: 'Direct / Indirect Expenses',
    aliases: ['Direct Expenses', 'Indirect Expenses'],
    plain: 'Cost of making or buying goods / Running costs',
    explain: 'Costs tied to the goods you sell, versus day-to-day costs like rent and electricity; Total decides from the expense type.',
    sources: ['audit']
  },
  salesLedger: {
    term: 'Sales ledger / Purchase ledger',
    aliases: ['Sales ledger', 'Purchase ledger', 'Sales account', 'Purchase account'],
    plain: 'Sales / Purchases',
    explain: 'The account your sales or purchases add up in; Total sets one up for you.',
    sources: ['audit']
  },
  capitalAccount: {
    term: 'Capital Account',
    plain: 'Owner’s money',
    explain: 'What the owner has put into the business, plus profits kept in it.',
    sources: ['audit']
  },
  drawings: {
    term: 'Drawings',
    plain: 'Owner took money out',
    explain: 'Money or goods the owner took from the business for personal use.',
    sources: ['audit']
  },
  openingBalance: {
    term: 'Opening balance',
    plain: 'What you had on your start date',
    explain: 'The amount already in an account, or already owed, on the day you start recording in Total.',
    explainHi: 'जिस दिन से आप Total में लिखना शुरू करते हैं, उस दिन किसी खाते में पहले से जो रकम है या बाकी है।',
    explainHinglish: 'Jis din se aap Total mein likhna shuru karte hain, us din kisi khaate mein pehle se jo rakam hai ya baaki hai.',
    sources: ['gpt']
  },
  drCr: {
    term: 'Dr / Cr',
    aliases: ['Dr', 'Cr', 'Debit / Credit', 'Debit', 'Credit'],
    plain: 'Side of the entry (set for you)',
    explain: 'Every entry touches two accounts on opposite sides; in everyday entry Total sets the sides, so you never pick them.',
    sources: ['audit', 'gpt']
  },
  particulars: {
    term: 'Particulars',
    plain: 'Account',
    explain: 'The account an entry line goes to.',
    sources: ['audit']
  },
  narration: {
    term: 'Narration',
    plain: 'Note',
    plainHi: 'टिप्पणी',
    explain: 'A short note to remember what the entry was for.',
    sources: ['audit', 'gpt']
  },

  // ----- bills and dues -----
  billWise: {
    term: 'Bill-wise allocation',
    aliases: ['Bill allocation', 'Agst Ref', 'Against reference'],
    plain: 'Which bills does this pay?',
    explain: 'Links a payment to the bills it settles, so you know exactly which ones are still unpaid.',
    sources: ['audit', 'gpt']
  },
  outstandings: {
    term: 'Outstandings',
    aliases: ['Outstanding', 'Receivables ageing'],
    plain: 'Unpaid bills / Who owes me',
    explain: 'Bills not yet paid, by you or to you, as on today.',
    explainHi: 'आज तक जो बिल चुकाए नहीं गए — आपके या आपको।',
    explainHinglish: 'Aaj tak jo bill chukaye nahi gaye — aapke ya aapko.',
    sources: ['audit', 'gpt']
  },
  ageing: {
    term: 'Ageing',
    aliases: ['Aging', 'Ageing analysis'],
    plain: 'How long overdue',
    explain: 'How many days each unpaid bill has been waiting past its due date.',
    sources: ['audit', 'gpt']
  },
  soa: {
    term: 'SOA',
    aliases: ['Statement of account'],
    plain: 'Statement',
    explain: 'A list of a customer’s bills and payments with what they still owe.',
    sources: ['audit']
  },
  creditControl: {
    term: 'Credit control',
    plain: 'Payment reminders',
    explain: 'Following up customers who are late to pay, and stopping credit to those who are far behind.',
    sources: ['audit']
  },
  advanceReceipt: {
    term: 'Advance receipt',
    plain: 'Advance (no bill yet)',
    explain: 'Money a customer paid before you made their bill.',
    sources: ['audit']
  },
  taxableValue: {
    term: 'Taxable value',
    plain: 'Price before GST',
    explain: 'The amount GST is worked out on.',
    explainHi: 'वह रकम जिस पर GST लगता है।',
    explainHinglish: 'Woh rakam jis par GST lagta hai.',
    sources: ['audit']
  },
  roundOff: {
    term: 'Round off',
    plain: 'Rounding',
    explain: 'The few paise added or removed so the bill total is a whole rupee.',
    explainHi: 'बिल का कुल पूरे रुपये में करने के लिए जोड़े या घटाए गए कुछ पैसे।',
    explainHinglish: 'Bill ka total poore rupaye mein karne ke liye jode ya ghataaye gaye kuch paise.',
    sources: ['audit']
  },

  // ----- stock -----
  stockItem: {
    term: 'Stock item',
    plain: 'Product',
    explain: 'Something you buy, make or sell and keep count of.',
    sources: ['audit']
  },
  godown: {
    term: 'Godown',
    aliases: ['Godowns'],
    plain: 'Location / Warehouse',
    plainHi: 'गोदाम',
    plainHinglish: 'Godaam',
    explain: 'A place where you keep stock — the shop, a store room or a warehouse.',
    sources: ['audit', 'gpt']
  },
  bom: {
    term: 'BOM',
    aliases: ['Bill of materials'],
    plain: 'Recipe / Materials needed',
    explain: 'What goes into making one unit of a product.',
    sources: ['gpt']
  },
  grn: {
    term: 'GRN',
    aliases: ['Goods receipt note', 'Receipt note'],
    plain: 'Goods received',
    explain: 'A note that goods arrived from a supplier, before or without their bill.',
    sources: ['gpt']
  },
  deliveryChallan: {
    term: 'Delivery challan',
    aliases: ['Delivery note', 'Challan'],
    plain: 'Goods sent',
    explain: 'A note that goods went to a customer, before or without a bill.',
    sources: ['audit']
  },
  closingStock: {
    term: 'Closing stock',
    plain: 'Stock left at the end',
    explain: 'The value of products still on hand at the end of the period; it is why profit is not simply sales minus purchases.',
    explainHi: 'अवधि के आख़िर में बचे माल की कीमत; इसी वजह से मुनाफ़ा सिर्फ़ बिक्री घटा खरीद नहीं होता।',
    explainHinglish: 'Period ke aakhir mein bache maal ki keemat; isi wajah se profit sirf sales minus purchase nahi hota.',
    sources: ['audit']
  },
  grossProfit: {
    term: 'Gross profit',
    aliases: ['Gross profit c/o', 'Gross profit b/f'],
    plain: 'Profit on goods sold',
    explain: 'Sales minus what the goods you sold cost you, before running costs.',
    explainHi: 'बिक्री में से बेचे गए माल की लागत घटाकर, रोज़ के खर्चों से पहले।',
    explainHinglish: 'Sales mein se beche gaye maal ki laagat ghata kar, roz ke kharchon se pehle.',
    sources: ['audit']
  },

  // ----- statements -----
  profitAndLoss: {
    term: 'Profit & Loss',
    aliases: ['P&L', 'Profit and Loss'],
    plain: 'How is my business doing',
    explain: 'Sales minus the cost of goods sold minus expenses, for the period you pick.',
    explainHi: 'चुनी हुई अवधि की बिक्री, घटा बेचे माल की लागत, घटा खर्च।',
    explainHinglish: 'Chuni hui period ki sales, minus beche maal ki laagat, minus kharche.',
    sources: ['audit']
  },
  trialBalance: {
    term: 'Trial balance',
    plain: 'Trial balance (for your CA)',
    explain: 'Every account’s balance on one page — your CA uses it to check the books.',
    explainHi: 'हर खाते का बैलेंस एक पेज पर — आपका CA इससे हिसाब जाँचता है।',
    explainHinglish: 'Har khaate ka balance ek page par — aapka CA isse hisaab jaanchta hai.',
    sources: ['audit']
  },
  balanceSheet: {
    term: 'Balance sheet',
    plain: 'Balance sheet (for your CA)',
    explain: 'What the business owns and owes on a date.',
    explainHi: 'किसी तारीख पर कारोबार के पास क्या है और उस पर क्या बाकी है।',
    explainHinglish: 'Kisi tareekh par business ke paas kya hai aur us par kya baaki hai.',
    sources: ['audit']
  },
  cashFlow: {
    term: 'Cash flow',
    plain: 'Where the cash came from and went',
    explain: 'How cash and bank changed over a period, and why.',
    sources: ['audit']
  },
  brs: {
    term: 'BRS',
    aliases: ['Bank reconciliation', 'Bank reconciliation statement', 'Reconciliation'],
    plain: 'Match with bank statement',
    explain: 'Checks your entries against the bank’s statement so both show the same money.',
    sources: ['audit']
  },
  yearEndClose: {
    term: 'Year-end close',
    plain: 'Start the new financial year',
    explain: 'Carries balances into the new year; income and expenses start again from zero.',
    sources: ['audit']
  },
  costCentre: {
    term: 'Cost centre',
    aliases: ['Cost centres'],
    plain: 'Cost tracking (branch, project or person)',
    explain: 'A tag on costs and income so you can see them per branch, project or person.',
    sources: ['audit']
  },

  // ----- GST and other taxes -----
  gstin: {
    term: 'GSTIN',
    plain: 'GST number',
    explain: 'Your 15-character GST Identification Number; it starts with your state code.',
    explainHi: 'आपका 15 अक्षरों का GST नंबर; यह आपके राज्य के कोड से शुरू होता है।',
    explainHinglish: 'Aapka 15 akshar ka GST number; yeh aapke state ke code se shuru hota hai.',
    sources: ['audit']
  },
  hsn: {
    term: 'HSN',
    aliases: ['HSN code', 'SAC'],
    plain: 'Product tax code (HSN)',
    explain: 'A code that tells GST what kind of product or service it is; Total helps you find it by name.',
    explainHi: 'एक कोड जो GST को बताता है कि माल या सेवा किस तरह की है; Total नाम से इसे ढूँढने में मदद करता है।',
    explainHinglish: 'Ek code jo GST ko batata hai ki maal ya service kis tarah ki hai; Total naam se ise dhoondhne mein madad karta hai.',
    sources: ['audit']
  },
  itc: {
    term: 'ITC',
    aliases: ['Input tax credit', 'Input tax'],
    plain: 'GST on purchases you can claim',
    explain: 'GST you paid on business purchases that can reduce the GST you owe, once the supplier’s filing confirms it (GSTR-2B).',
    explainHi: 'कारोबार की खरीद पर दिया GST, जो सप्लायर की फाइलिंग (GSTR-2B) से पक्का होने पर आपका देने वाला GST कम करता है।',
    explainHinglish: 'Business ki kharid par diya GST, jo supplier ki filing (GSTR-2B) se pakka hone par aapka dene wala GST kam karta hai.',
    sources: ['audit', 'gpt']
  },
  outputTax: {
    term: 'Output tax',
    aliases: ['Output GST'],
    plain: 'GST you collected',
    explain: 'The GST you charged customers on your bills, which you pay to the government.',
    explainHi: 'आपने अपने बिलों पर ग्राहकों से जो GST लिया, जो आप सरकार को देते हैं।',
    explainHinglish: 'Aapne apne bills par customers se jo GST liya, jo aap sarkar ko dete hain.',
    sources: ['audit']
  },
  setOff: {
    term: 'Set-off',
    aliases: ['Set off', 'ITC set-off'],
    plain: 'GST to pay after your purchase credit',
    explain: 'GST you collected, reduced by the purchase GST you can claim; what remains is paid in cash.',
    sources: ['audit']
  },
  rcm: {
    term: 'RCM',
    aliases: ['Reverse charge', 'Reverse charge mechanism'],
    plain: 'GST you must pay for this purchase',
    explain: 'For some purchases the buyer, not the supplier, pays the GST to the government.',
    explainHi: 'कुछ खरीद पर GST सप्लायर नहीं, खरीदने वाला सरकार को देता है।',
    explainHinglish: 'Kuch kharid par GST supplier nahi, khareedne wala sarkar ko deta hai.',
    sources: ['gpt']
  },
  gstr1: {
    term: 'GSTR-1',
    plain: 'Your sales for GST',
    explain: 'The GST return listing your sales; Total prepares the file and you upload it on gst.gov.in.',
    explainHi: 'आपकी बिक्री की सूची वाला GST रिटर्न; Total फ़ाइल तैयार करता है और आप उसे gst.gov.in पर अपलोड करते हैं।',
    explainHinglish: 'Aapki sales ki list wala GST return; Total file taiyaar karta hai aur aap use gst.gov.in par upload karte hain.',
    sources: ['audit', 'gpt']
  },
  gstr3b: {
    term: 'GSTR-3B',
    plain: 'GST summary and payment',
    explain: 'The monthly or quarterly GST summary where you pay what you owe; Total prepares it, you file it.',
    explainHi: 'महीने या तिमाही का GST सारांश, जिसमें आप बाकी GST भरते हैं; Total इसे तैयार करता है, फाइल आप करते हैं।',
    explainHinglish: 'Mahine ya quarter ka GST summary, jismein aap baaki GST bharte hain; Total ise taiyaar karta hai, file aap karte hain.',
    sources: ['audit', 'gpt']
  },
  gstr2b: {
    term: 'GSTR-2B',
    aliases: ['GSTR-2B recon', '2B'],
    plain: 'Check supplier bills against the GST portal',
    explain: 'The portal’s list of bills your suppliers reported; purchase GST not in it awaits confirmation.',
    explainHi: 'पोर्टल पर आपके सप्लायरों के दिखाए बिलों की सूची; जो खरीद GST इसमें नहीं है, वह पक्का होने का इंतज़ार कर रहा है।',
    explainHinglish: 'Portal par aapke suppliers ke dikhaye bills ki list; jo kharid ka GST ismein nahi hai, woh pakka hone ka intezaar kar raha hai.',
    sources: ['audit', 'gpt']
  },
  composition: {
    term: 'Composition scheme',
    aliases: ['Composition'],
    plain: 'Composition scheme (simpler GST)',
    explain: 'A simpler GST option for small businesses: you pay a fixed rate on turnover and issue a bill of supply, not a tax invoice.',
    explainHi: 'छोटे कारोबार के लिए आसान GST तरीका: आप बिक्री पर तय दर से टैक्स भरते हैं और टैक्स इनवॉइस की जगह बिल ऑफ़ सप्लाई देते हैं।',
    explainHinglish: 'Chhote business ke liye aasaan GST tarika: aap sales par tay dar se tax bharte hain aur tax invoice ki jagah bill of supply dete hain.',
    sources: ['gpt']
  },
  eInvoice: {
    term: 'e-Invoice',
    aliases: ['IRN', 'E-invoice'],
    plain: 'e-Invoice (registered with the GST system)',
    explain: 'A bill registered on the government portal; needed only once your turnover crosses the GST limit.',
    explainHi: 'सरकारी पोर्टल पर दर्ज बिल; यह तभी चाहिए जब आपकी बिक्री GST की सीमा पार कर ले।',
    explainHinglish: 'Sarkari portal par darj bill; yeh tabhi chahiye jab aapki sales GST ki seema paar kar le.',
    sources: ['audit']
  },
  eWayBill: {
    term: 'e-Way bill',
    aliases: ['E-way bill', 'EWB'],
    plain: 'e-Way bill (for moving goods)',
    explain: 'A permit from the GST portal for moving goods above a value limit.',
    explainHi: 'एक तय कीमत से ज़्यादा का माल ले जाने के लिए GST पोर्टल की अनुमति।',
    explainHinglish: 'Ek tay keemat se zyada ka maal le jaane ke liye GST portal ki anumati.',
    sources: ['audit']
  },
  tds: {
    term: 'TDS',
    aliases: ['Tax deducted at source'],
    plain: 'Tax you deduct when paying (TDS)',
    explain: 'Income tax you cut from certain payments, like rent or contractor bills above the limits, and deposit for the payee.',
    explainHi: 'कुछ भुगतानों से काटा गया इनकम टैक्स, जैसे किराया या ठेकेदार के बिल, जो आप पाने वाले के नाम पर जमा करते हैं।',
    explainHinglish: 'Kuch payments se kaata gaya income tax, jaise kiraya ya contractor ke bill, jo aap paane wale ke naam par jama karte hain.',
    sources: ['audit']
  },
  tcs: {
    term: 'TCS',
    aliases: ['Tax collected at source'],
    plain: 'Tax you collect when selling (TCS)',
    explain: 'Tax you add to certain sales and deposit for the buyer.',
    explainHi: 'कुछ बिक्री पर जोड़ा गया टैक्स, जो आप खरीदने वाले के नाम पर जमा करते हैं।',
    explainHinglish: 'Kuch sales par joda gaya tax, jo aap khareedne wale ke naam par jama karte hain.',
    sources: ['audit']
  }
} as const satisfies Record<string, GlossaryEntry>

export type GlossaryTerm = keyof typeof GLOSSARY

const ENTRIES = GLOSSARY as Record<GlossaryTerm, GlossaryEntry>
const byName = new Map<string, GlossaryTerm>()
for (const [id, entry] of Object.entries(ENTRIES) as [GlossaryTerm, GlossaryEntry][]) {
  for (const name of [id, entry.term, ...(entry.aliases ?? [])]) byName.set(name.trim().toLowerCase(), id)
}

/** The entry for an id, a term or an alias (case-insensitive), or null. */
export function glossaryEntry(term: GlossaryTerm | string): GlossaryEntry | null {
  const id = byName.get(term.trim().toLowerCase())
  return id ? ENTRIES[id] : null
}

/** The plain word for a term in `lang` (falls back to English; an unknown term is returned
 *  unchanged so a caller never shows an empty label). */
export function plain(term: GlossaryTerm | string, lang: Language = 'en'): string {
  const e = glossaryEntry(term)
  if (!e) return term
  if (lang === 'hi' && e.plainHi) return e.plainHi
  if (lang === 'hinglish' && e.plainHinglish) return e.plainHinglish
  return e.plain
}

/** The one-sentence explanation in `lang` (falls back to English where it has no translation),
 *  or null for an unknown term. */
export function explain(term: GlossaryTerm | string, lang: Language = 'en'): string | null {
  const e = glossaryEntry(term)
  if (!e) return null
  if (lang === 'hi' && e.explainHi) return e.explainHi
  if (lang === 'hinglish' && e.explainHinglish) return e.explainHinglish
  return e.explain
}
