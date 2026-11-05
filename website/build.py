"""Builds the deployable website into website/dist.

The start page is written as page content (as the preview needs it); here it gets
its full HTML document around it. The other files are copied as they are, and the
browser demo comes from the single-file build of the prototype (npm run build:single).
"""
import pathlib
import re
import html
import json
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
DIST = ROOT / 'dist'
DEMO = ROOT.parent / 'dist-single' / 'index.html'
# Address the site is published at (link previews need absolute URLs): python3 build.py https://dev.bitcrane.de
SITE = (sys.argv[1] if len(sys.argv) > 1 else 'https://bitcrane.de').rstrip('/')
# Version shown on the page (major.minor). Second argument, else the latest GitHub release.
VERSION = sys.argv[2] if len(sys.argv) > 2 else None


def latest_version():
    try:
        tag = subprocess.run(['gh', 'api', 'repos/Raccoon-Works/bitcrane/releases/latest', '-q', '.tag_name'],
                             capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        tag = ''
    m = re.match(r'v?(\d+)\.(\d+)', tag)
    return f'{m.group(1)}.{m.group(2)}' if m else None

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
    version = VERSION or latest_version()
    if version:
        page = re.sub(r'<span data-version>[^<]*</span>', f'<span data-version>{version}</span>', page)
    print('version', version or '(as written in the page)')
    # The <title>, metas and <style> at the top of a page belong in the head; the rest is the body.
    def write(name, text):
        split = text.index('</style>') + len('</style>')
        head_part, body_part = text[:split], text[split:]
        head_part = head_part.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
        (DIST / name).write_text(HEAD.replace('{site}', SITE) + head_part + '\n</head>\n<body>\n' + body_part.lstrip() + '\n</body>\n</html>\n', encoding='utf-8')

    # Start page: variant B (large wordmark head, see variant_b.py). The earlier head stays
    # reachable as index-a.html for comparison.
    sys.path.insert(0, str(ROOT))
    import variant_b
    write('index.html', variant_b.make(page))
    write('index-a.html', page)
    for name in ['legal.css', '.htaccess', '404.html', 'kontakt.php', 'demo.html']:
        shutil.copy2(ROOT / name, DIST / name)
    # Legal pages: the owner's name and address come from private.json, which exists only in the
    # local folder and never in the public repository. Missing values stay marked placeholders.
    private = json.loads((ROOT / 'private.json').read_text(encoding='utf-8')) if (ROOT / 'private.json').exists() else {}
    for name in ['impressum.html', 'datenschutz.html']:
        text = (ROOT / name).read_text(encoding='utf-8')
        def fill(m):
            value = (private.get(m.group(1)) or '').strip()
            return html.escape(value) if value else m.group(0)
        text = re.sub(r'<mark data-private="(\w+)">[^<]*</mark>', fill, text)
        if private.get('name') and private.get('street') and private.get('city'):
            text = re.sub(r'\s*<p class="note">.*?</p>', '', text, count=1, flags=re.S)
        (DIST / name).write_text(text, encoding='utf-8')
    # Private addresses of the contact form: only in the local folder, never in the repository.
    if (ROOT / 'kontakt.config.php').exists():
        shutil.copy2(ROOT / 'kontakt.config.php', DIST / 'kontakt.config.php')
    # The test site stays out of search engines; the real one invites them in.
    test = '://dev.' in SITE
    (DIST / 'robots.txt').write_text('User-agent: *\nDisallow: /\n' if test else f'User-agent: *\nAllow: /\nSitemap: {SITE}/sitemap.xml\n', encoding='utf-8')
    if not test:
        pages = ['', 'impressum.html', 'datenschutz.html']
        (DIST / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                                          + ''.join(f'  <url><loc>{SITE}/{p}</loc></url>\n' for p in pages) + '</urlset>\n', encoding='utf-8')
    else:
        for name in ['index.html', 'index-a.html']:
            f = DIST / name
            f.write_text(f.read_text(encoding='utf-8').replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="robots" content="noindex">', 1), encoding='utf-8')
    shutil.copytree(ROOT / 'img', DIST / 'img')
    shutil.copytree(ROOT / 'vid', DIST / 'vid')
    (DIST / 'demo').mkdir()
    # The demo opened in its own window needs a way to the legal pages (two clicks at most);
    # inside the start page (iframe) the page's own footer covers it.
    demo = DEMO.read_text(encoding='utf-8')
    legal = (
        '<div id="bc-legal" hidden style="position:fixed;left:50%;bottom:3px;transform:translateX(-50%);z-index:9999;'
        'font:500 11px -apple-system,BlinkMacSystemFont,\'Segoe UI\',system-ui,sans-serif;letter-spacing:.01em;opacity:.7">'
        '<a href="../impressum.html" style="color:inherit">Impressum</a> &middot; <a href="../datenschutz.html" style="color:inherit">Datenschutz</a></div>'
        '<script>(function(){if(window.top!==window)return;var d=document.getElementById("bc-legal");'
        'var dark=/theme=dark/.test(location.search)||(!/theme=light/.test(location.search)&&matchMedia("(prefers-color-scheme: dark)").matches);'
        'd.style.color=dark?"#c9d4e1":"#4a5668";var en=/lang=en/.test(location.search);'
        'if(en){d.children[0].textContent="Legal notice";d.children[1].textContent="Privacy";}d.hidden=false;})();</script>\n'
    )
    (DIST / 'demo' / 'index.html').write_text(demo.replace('</body>', legal + '</body>', 1), encoding='utf-8')
    print('built', sum(1 for _ in DIST.rglob('*') if _.is_file()), 'files in', DIST)


if __name__ == '__main__':
    main()
