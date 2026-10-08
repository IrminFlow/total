# Generates statement.xlsx — the XLSX reader's unit-test fixture (src/shared/bankFormats/xlsx.ts).
# Hand-built OOXML parts zipped with Python's zipfile (DEFLATE), so the test exercises the
# zero-dependency unzip + inflate path, shared strings, an inline string, a built-in date style
# (numFmtId 14), a custom date format (numFmt 164 'dd-mmm-yyyy'), plain numbers and a sparse row.
# Run: python3 -I src/shared/bankFormats/fixtures/make-xlsx.py
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'statement.xlsx')

content_types = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>'''

root_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>'''

workbook = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<workbookPr/>
<sheets><sheet name="Statement" sheetId="1" r:id="rId7"/></sheets>
</workbook>'''

workbook_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''

strings = [
    'ICICI Bank - Detailed Statement',          # 0
    'Transaction Date',                          # 1
    'Transaction Remarks',                       # 2
    'Cheque Number',                             # 3
    'Withdrawal Amount (INR )',                  # 4
    'Deposit Amount (INR )',                     # 5
    'Balance (INR )',                            # 6
    'NEFT-ICIC0000104-ACME TRADERS PVT LTD',     # 7
    'UPI/321456789012/RAVI KUMAR/RENT',          # 8
]
sst = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
       '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="%d" uniqueCount="%d">' % (len(strings), len(strings))
       + ''.join('<si><t>%s</t></si>' % s for s in strings)
       # a rich-text shared string (two runs) — index 9
       + '<si><r><rPr><b/></rPr><t>CHQ PAID </t></r><r><t>SHREE &amp; CO</t></r></si>'
       + '</sst>')

styles = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\-mmm\\-yyyy"/></numFmts>
<cellXfs count="4">
<xf numFmtId="0"/>
<xf numFmtId="14" applyNumberFormat="1"/>
<xf numFmtId="164" applyNumberFormat="1"/>
<xf numFmtId="4" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>'''

# 2026-08-02 = serial 46236; 2026-08-03 = 46237; 2026-08-05 = 46239
sheet = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c></row>
<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" t="s"><v>2</v></c><c r="C3" t="s"><v>3</v></c><c r="D3" t="s"><v>4</v></c><c r="E3" t="s"><v>5</v></c><c r="F3" t="s"><v>6</v></c></row>
<row r="4"><c r="A4" s="1"><v>46236</v></c><c r="B4" t="s"><v>7</v></c><c r="E4" s="3"><v>25000</v></c><c r="F4" s="3"><v>175000</v></c></row>
<row r="5"><c r="A5" s="2"><v>46237</v></c><c r="B5" t="s"><v>8</v></c><c r="D5" s="3"><v>18000</v></c><c r="F5" s="3"><v>157000</v></c></row>
<row r="6"><c r="A6" t="inlineStr"><is><t>05/08/2026</t></is></c><c r="B6" t="s"><v>9</v></c><c r="C6" t="str"><v>000123</v></c><c r="D6"><v>7450.5</v></c><c r="F6"><v>149549.5</v></c></row>
</sheetData>
</worksheet>'''

with zipfile.ZipFile(OUT, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', content_types)
    z.writestr('_rels/.rels', root_rels)
    z.writestr('xl/workbook.xml', workbook)
    z.writestr('xl/_rels/workbook.xml.rels', workbook_rels)
    z.writestr('xl/sharedStrings.xml', sst)
    z.writestr('xl/styles.xml', styles)
    z.writestr('xl/worksheets/sheet1.xml', sheet)
print('wrote', OUT)
