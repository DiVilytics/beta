# Stamps a version on every page's scripts and stylesheet (ui.js?v=…) and on the
# data files (ASSET_VERSION in config.js, which db.js adds to their addresses),
# so a browser never pairs a new file with an old one it kept: GitHub Pages lets
# browsers keep each file for 10 minutes, and a page mixing two releases breaks.
# Run by the Pages workflow on the copy it deploys; the repository keeps none.
import pathlib
import re
import sys

version = sys.argv[1]
root = pathlib.Path(__file__).resolve().parent.parent

# Local files only: not the CDN scripts, not the site-wide /asset/ paths.
ref = re.compile(r'((?:src|href)="(?!https?:|/)[^"?#]+\.(?:js|css))(?:\?v=[^"]*)?"')
for page in root.glob('*.html'):
    page.write_text(ref.sub(lambda m: f'{m.group(1)}?v={version}"', page.read_text()))

config = root / 'config.js'
config.write_text(re.sub(r"const ASSET_VERSION = '[^']*';", f"const ASSET_VERSION = '{version}';", config.read_text()))
print(f'stamped {version}')
