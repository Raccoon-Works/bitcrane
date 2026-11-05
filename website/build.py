"""Builds the deployable website into website/dist.

    python3 website/build.py https://dev.bitcrane.de 0.3

First argument: the address the site is published at (link previews need absolute URLs; a
"dev." address keeps search engines out). Second: the version shown on the page (major.minor),
else the latest GitHub release.

The pages work as they are in website/; the build only
  - fills in the address, the version and the owner's private data (private.json, never in the
    public repository),
  - inlines js/prefs.js (it must run before the first paint),
  - stamps css/ and js/ with one content hash, so browsers keep them long but never stale,
  - writes robots.txt (and sitemap.xml for the real site),
  - adds the browser demo from the prototype's single-file build (npm run build:single).
"""
import hashlib
import html
import json
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
DIST = ROOT / 'dist'
DEMO = ROOT.parent / 'dist-single' / 'index.html'
PAGES = ['index.html', 'demo.html', 'impressum.html', 'datenschutz.html', '404.html', 'kontakt.php']
COPY = ['.htaccess', 'css', 'js', 'img', 'vid']

SITE = (sys.argv[1] if len(sys.argv) > 1 else 'https://bitcrane.de').rstrip('/')
VERSION = sys.argv[2] if len(sys.argv) > 2 else None
TEST = '://dev.' in SITE


def latest_version():
    """major.minor of the latest GitHub release, or None when it cannot be asked."""
    try:
        tag = subprocess.run(['gh', 'api', 'repos/Raccoon-Works/bitcrane/releases/latest', '-q', '.tag_name'],
                             capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.match(r'v?(\d+)\.(\d+)', tag)
    return f'{m.group(1)}.{m.group(2)}' if m else None


def asset_hash():
    """One hash over all styles and scripts: any change gives every file a new address."""
    h = hashlib.sha256()
    for f in sorted([*(ROOT / 'css').glob('*.css'), *(ROOT / 'js').glob('*.js')]):
        h.update(f.name.encode() + f.read_bytes())
    return h.hexdigest()[:10]


def fill_private(text, private):
    """Legal pages: the owner's name and address replace the marked placeholders; once all are
    known, the note about missing data goes too."""
    def fill(m):
        value = (private.get(m.group(1)) or '').strip()
        return html.escape(value) if value else m.group(0)
    text = re.sub(r'<mark data-private="(\w+)">[^<]*</mark>', fill, text)
    if all(private.get(k) for k in ('name', 'street', 'city')):
        text = re.sub(r'\s*<p class="note">.*?</p>', '', text, count=1, flags=re.S)
    return text


def demo_app():
    """The browser demo for the site. The prototype names Inter from Google Fonts only as a
    fallback behind the system fonts; on the site that request would send every visitor's
    address to Google, so it goes. The demo opened in its own window also needs a way to the
    legal pages; inside the start page and demo.html (iframes) the page around it has them."""
    legal = (
        '<div id="bc-legal" hidden style="position:fixed;left:50%;bottom:3px;transform:translateX(-50%);z-index:9999;'
        'font:500 11px -apple-system,BlinkMacSystemFont,\'Segoe UI\',system-ui,sans-serif;letter-spacing:.01em;opacity:.7">'
        '<a href="../impressum.html" style="color:inherit">Impressum</a> &middot; <a href="../datenschutz.html" style="color:inherit">Datenschutz</a></div>'
        '<script>(function(){if(window.top!==window)return;var d=document.getElementById("bc-legal");'
        'var dark=/theme=dark/.test(location.search)||(!/theme=light/.test(location.search)&&matchMedia("(prefers-color-scheme: dark)").matches);'
        'd.style.color=dark?"#c9d4e1":"#4a5668";if(/lang=en/.test(location.search)){d.children[0].textContent="Legal notice";'
        'd.children[1].textContent="Privacy";}d.hidden=false;})();</script>\n'
    )
    app = DEMO.read_text(encoding='utf-8')
    app = re.sub(r'[ \t]*<link[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>\n?', '', app)
    if 'fonts.g' in app:
        raise SystemExit('Google Fonts are still referenced in the demo')
    return app.replace('</body>', legal + '</body>', 1)


def main():
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()
    for name in COPY:
        src = ROOT / name
        (shutil.copytree if src.is_dir() else shutil.copy2)(src, DIST / name)

    version = VERSION or latest_version()
    stamp = asset_hash()
    prefs = '<script>\n' + (ROOT / 'js' / 'prefs.js').read_text(encoding='utf-8').strip() + '\n</script>'
    private_file = ROOT / 'private.json'
    private = json.loads(private_file.read_text(encoding='utf-8')) if private_file.exists() else {}
    # The test site may show placeholders; the real one must never publish a legal notice without them.
    if not TEST and not all(private.get(k) for k in ('name', 'street', 'city')):
        raise SystemExit('private.json needs name, street and city for the real site')

    for name in PAGES:
        text = (ROOT / name).read_text(encoding='utf-8')
        text = text.replace('{{SITE}}', SITE)
        if version:
            text = re.sub(r'<span data-version>[^<]*</span>', f'<span data-version>{version}</span>', text)
        text = re.sub(r'<script src="/?js/prefs\.js"></script>', lambda m: prefs, text)
        text = re.sub(r'((?:href|src)="/?(?:css|js)/[\w-]+\.(?:css|js))"', rf'\1?v={stamp}"', text)
        if name in ('impressum.html', 'datenschutz.html'):
            text = fill_private(text, private)
        if TEST and name in ('index.html', 'demo.html'):
            text = text.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="robots" content="noindex">', 1)
        (DIST / name).write_text(text, encoding='utf-8')

    # Modules import each other: the same stamp, so each file has exactly one address.
    (DIST / 'js' / 'prefs.js').unlink()
    for f in (DIST / 'js').glob('*.js'):
        f.write_text(re.sub(r"(from '\./[\w-]+\.js)'", rf"\1?v={stamp}'", f.read_text(encoding='utf-8')), encoding='utf-8')

    # Mail addresses of the contact form: only in the local folder, never in the repository.
    if (ROOT / 'kontakt.config.php').exists():
        shutil.copy2(ROOT / 'kontakt.config.php', DIST / 'kontakt.config.php')

    # The test site stays out of search engines; the real one invites them in.
    if TEST:
        (DIST / 'robots.txt').write_text('User-agent: *\nDisallow: /\n', encoding='utf-8')
    else:
        (DIST / 'robots.txt').write_text(f'User-agent: *\nAllow: /\nSitemap: {SITE}/sitemap.xml\n', encoding='utf-8')
        # Only the start page: the legal pages are kept out of search engines (see .htaccess).
        (DIST / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n'
                                          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                                          f'  <url><loc>{SITE}/</loc></url>\n</urlset>\n', encoding='utf-8')

    (DIST / 'demo').mkdir()
    (DIST / 'demo' / 'index.html').write_text(demo_app(), encoding='utf-8')

    print('version', version or '(as written in the page)', '· assets', stamp)
    print('built', sum(1 for f in DIST.rglob('*') if f.is_file()), 'files in', DIST)


if __name__ == '__main__':
    main()
