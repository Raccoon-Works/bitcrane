"""Builds the deployable website into website/dist.

The start page is written as page content (as the preview needs it); here it gets
its full HTML document around it. The other files are copied as they are, and the
browser demo comes from the single-file build of the prototype (npm run build:single).
"""
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent
DIST = ROOT / 'dist'
DEMO = ROOT.parent / 'dist-single' / 'index.html'
# Address the site is published at (link previews need absolute URLs): python3 build.py https://dev.bitcrane.de
SITE = (sys.argv[1] if len(sys.argv) > 1 else 'https://bitcrane.de').rstrip('/')

HEAD = """<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta property="og:title" content="Bitcrane">
<meta property="og:description" content="SFTP, FTP, WebDAV, SMB, S3 und Cloud für macOS und Windows, mit Ordnerüberwachung, SSH-Terminal und Editor.">
<meta property="og:image" content="{site}/img/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="{site}/">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="apple-touch-icon" href="img/icon-180.png">
<style>
:root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
body { margin: 0; }
img { max-width: 100%; }
[hidden] { display: none !important; }
</style>
"""


def main():
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()
    page = (ROOT / 'index.html').read_text(encoding='utf-8')
    # The <title>, metas and <style> at the top of the page belong in the head; the rest is the body.
    split = page.index('</style>') + len('</style>')
    head_part, body_part = page[:split], page[split:]
    head_part = head_part.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
    (DIST / 'index.html').write_text(HEAD.replace('{site}', SITE) + head_part + '\n</head>\n<body>\n' + body_part.lstrip() + '\n</body>\n</html>\n', encoding='utf-8')
    for name in ['impressum.html', 'datenschutz.html', 'legal.css', '.htaccess']:
        shutil.copy2(ROOT / name, DIST / name)
    shutil.copytree(ROOT / 'img', DIST / 'img')
    (DIST / 'demo').mkdir()
    shutil.copy2(DEMO, DIST / 'demo' / 'index.html')
    print('built', sum(1 for _ in DIST.rglob('*') if _.is_file()), 'files in', DIST)


if __name__ == '__main__':
    main()
