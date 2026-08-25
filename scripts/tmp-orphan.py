import re, glob

for p in sorted(glob.glob('src/renderer/src/screens/**/*.tsx', recursive=True)):
    s = open(p).read()
    for m in re.finditer(r'<div className="([^"]*justify-end[^"]*)">\n((?:.*\n)*?)\s*</div>\n', s):
        body = m.group(2)
        tags = re.findall(r'<([A-Z]\w+)\b', body)
        if len(tags) == 1:
            line = s[:m.start()].count('\n') + 1
            print('%s:%d  %s  -> %s' % (p, line, m.group(1), tags))
