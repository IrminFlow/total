import type { InvoiceLabelLanguage } from "./invoiceConfig";

export const INVOICE_LABEL_LANGUAGE_OPTIONS: {
  value: InvoiceLabelLanguage;
  label: string;
}[] = [
  { value: "en", label: "English" },
  { value: "hi", label: "हिंदी (Hindi)" },
  { value: "mr", label: "मराठी (Marathi)" },
  { value: "gu", label: "ગુજરાતી (Gujarati)" },
  { value: "ta", label: "தமிழ் (Tamil)" },
];

export interface InvoiceLabels {
  billedTo: string;
  invoice: string;
  number: string;
  date: string;
  placeOfSupply: string;
  vehicle: string;
  description: string;
  quantity: string;
  rate: string;
  discount: string;
  amount: string;
  broughtForward: string;
  carriedForward: string;
  taxable: string;
  bankDetails: string;
  account: string;
  terms: string;
  verificationQr: string;
  amountInWords: string;
  declaration: string;
  taxableValue: string;
  total: string;
  receiverSignature: string;
  forCompany: string;
  unregistered: string;
  cashSale: string;
  enteredBy: string;
  alteredBy: string;
  roundOff: string;
}

const EN: InvoiceLabels = {
  billedTo: "Billed to",
  invoice: "Invoice",
  number: "No",
  date: "Date",
  placeOfSupply: "Place of supply",
  vehicle: "Vehicle",
  description: "Description",
  quantity: "Qty",
  rate: "Rate",
  discount: "Discount",
  amount: "Amount",
  broughtForward: "Brought forward",
  carriedForward: "Carried forward",
  taxable: "Taxable",
  bankDetails: "Bank details",
  account: "A/c",
  terms: "Terms",
  verificationQr: "Verification QR",
  amountInWords: "Amount in words",
  declaration: "Declaration",
  taxableValue: "Taxable value",
  total: "Total",
  receiverSignature: "Receiver's signature",
  forCompany: "For",
  unregistered: "Unregistered",
  cashSale: "Cash sale",
  enteredBy: "Entered by",
  alteredBy: "Altered by",
  roundOff: "Round off",
};

const LABELS: Record<InvoiceLabelLanguage, InvoiceLabels> = {
  en: EN,
  hi: {
    billedTo: "बिल प्राप्तकर्ता",
    invoice: "चालान",
    number: "क्रमांक",
    date: "दिनांक",
    placeOfSupply: "आपूर्ति का स्थान",
    vehicle: "वाहन",
    description: "विवरण",
    quantity: "मात्रा",
    rate: "दर",
    discount: "छूट",
    amount: "राशि",
    broughtForward: "पिछला योग",
    carriedForward: "अगले पृष्ठ का योग",
    taxable: "कर योग्य",
    bankDetails: "बैंक विवरण",
    account: "खाता",
    terms: "शर्तें",
    verificationQr: "सत्यापन QR",
    amountInWords: "राशि शब्दों में",
    declaration: "घोषणा",
    taxableValue: "कर योग्य मूल्य",
    total: "कुल",
    receiverSignature: "प्राप्तकर्ता के हस्ताक्षर",
    forCompany: "कृते",
    unregistered: "अपंजीकृत",
    cashSale: "नकद बिक्री",
    enteredBy: "प्रविष्टकर्ता",
    alteredBy: "परिवर्तनकर्ता",
    roundOff: "पूर्णांकन",
  },
  mr: {
    billedTo: "बिल प्राप्तकर्ता",
    invoice: "चलन",
    number: "क्रमांक",
    date: "दिनांक",
    placeOfSupply: "पुरवठ्याचे ठिकाण",
    vehicle: "वाहन",
    description: "वर्णन",
    quantity: "प्रमाण",
    rate: "दर",
    discount: "सवलत",
    amount: "रक्कम",
    broughtForward: "मागील बेरीज",
    carriedForward: "पुढील पानावरील बेरीज",
    taxable: "करपात्र",
    bankDetails: "बँक तपशील",
    account: "खाते",
    terms: "अटी",
    verificationQr: "पडताळणी QR",
    amountInWords: "अक्षरी रक्कम",
    declaration: "घोषणा",
    taxableValue: "करपात्र मूल्य",
    total: "एकूण",
    receiverSignature: "प्राप्तकर्त्याची स्वाक्षरी",
    forCompany: "करिता",
    unregistered: "नोंदणी नसलेले",
    cashSale: "रोख विक्री",
    enteredBy: "नोंदकर्ता",
    alteredBy: "बदलकर्ता",
    roundOff: "पूर्णांकन",
  },
  gu: {
    billedTo: "બિલ મેળવનાર",
    invoice: "ચલણ",
    number: "ક્રમ",
    date: "તારીખ",
    placeOfSupply: "પુરવઠાનું સ્થળ",
    vehicle: "વાહન",
    description: "વર્ણન",
    quantity: "જથ્થો",
    rate: "દર",
    discount: "છૂટ",
    amount: "રકમ",
    broughtForward: "આગળ લાવેલ સરવાળો",
    carriedForward: "આગળ લઈ જવાનો સરવાળો",
    taxable: "કરપાત્ર",
    bankDetails: "બેંક વિગતો",
    account: "ખાતું",
    terms: "શરતો",
    verificationQr: "ચકાસણી QR",
    amountInWords: "શબ્દોમાં રકમ",
    declaration: "ઘોષણા",
    taxableValue: "કરપાત્ર મૂલ્ય",
    total: "કુલ",
    receiverSignature: "પ્રાપ્તકર્તાની સહી",
    forCompany: "વતી",
    unregistered: "નોંધણી વગર",
    cashSale: "રોકડ વેચાણ",
    enteredBy: "દાખલ કરનાર",
    alteredBy: "ફેરફાર કરનાર",
    roundOff: "પૂર્ણાંક",
  },
  ta: {
    billedTo: "பில் பெறுபவர்",
    invoice: "விலைப்பட்டியல்",
    number: "எண்",
    date: "தேதி",
    placeOfSupply: "வழங்கும் இடம்",
    vehicle: "வாகனம்",
    description: "விவரம்",
    quantity: "அளவு",
    rate: "விகிதம்",
    discount: "தள்ளுபடி",
    amount: "தொகை",
    broughtForward: "முந்தைய கூட்டுத்தொகை",
    carriedForward: "அடுத்த பக்க கூட்டுத்தொகை",
    taxable: "வரி விதிக்கத்தக்கது",
    bankDetails: "வங்கி விவரங்கள்",
    account: "கணக்கு",
    terms: "விதிமுறைகள்",
    verificationQr: "சரிபார்ப்பு QR",
    amountInWords: "தொகை எழுத்தில்",
    declaration: "அறிவிப்பு",
    taxableValue: "வரி விதிக்கத்தக்க மதிப்பு",
    total: "மொத்தம்",
    receiverSignature: "பெறுபவர் கையொப்பம்",
    forCompany: "சார்பாக",
    unregistered: "பதிவு செய்யப்படாதது",
    cashSale: "ரொக்க விற்பனை",
    enteredBy: "பதிவு செய்தவர்",
    alteredBy: "மாற்றியவர்",
    roundOff: "முழுமைப்படுத்தல்",
  },
};

export function invoiceLabels(language: InvoiceLabelLanguage): InvoiceLabels {
  return LABELS[language] ?? EN;
}
