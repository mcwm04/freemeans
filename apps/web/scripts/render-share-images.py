# Renders public/og.png, logo-512.png, apple-touch-icon.png and favicon-32.png from the brand mark.
# Run after a brand change:  pip install playwright && playwright install chromium && python scripts/render-share-images.py .
import sys, pathlib
from playwright.sync_api import sync_playwright
web = pathlib.Path(sys.argv[1]).resolve()
fs = web / 'node_modules/@fontsource'
font = lambda p: (fs / p).as_uri()
MARK = '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><g fill="{c}"><rect x="12" y="10" width="11" height="44" rx="5.5"/><rect x="12" y="10" width="40" height="11" rx="5.5"/><rect x="12" y="27" width="28" height="11" rx="5.5"/><circle cx="46.5" cy="48.5" r="5.5"/></g></svg>'
css = f"""
@font-face {{ font-family: B; font-weight:700; src: url({font('bricolage-grotesque/files/bricolage-grotesque-latin-700-normal.woff2')}); }}
@font-face {{ font-family: P; src: url({font('ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2')}); }}
@font-face {{ font-family: U; src: url({font('noto-nastaliq-urdu/files/noto-nastaliq-urdu-arabic-400-normal.woff2')}); }}
* {{ margin:0; box-sizing:border-box; }}
"""
og = f"""<html><head><style>{css}
body {{ width:1200px; height:630px; background:#F5F3EE; color:#121815; font-family:P; padding:72px 80px; position:relative; overflow:hidden; }}
.top {{ display:flex; align-items:center; gap:18px; font-family:B; font-size:44px; letter-spacing:-1px; color:#0B6E69; }}
.top svg {{ width:64px; height:64px; }}
h1 {{ font-family:B; font-size:92px; line-height:96px; letter-spacing:-2px; margin-top:64px; }}
.ur {{ font-family:U; font-size:38px; color:#0B6E69; margin-top:18px; direction:rtl; text-align:left; unicode-bidi:plaintext; }}
.sub {{ font-size:30px; color:#3b4540; position:absolute; bottom:64px; left:80px; }}
.bars {{ position:absolute; right:-40px; top:120px; display:flex; flex-direction:column; gap:22px; }}
.bars span {{ display:block; height:56px; border-radius:28px; background:#0B6E69; opacity:.14; }}
</style></head><body>
<div class="bars"><span style="width:360px"></span><span style="width:260px"></span><span style="width:180px"></span></div>
<div class="top">{MARK.format(c='#0B6E69')}freemeans</div>
<h1>Free means<br>you can build.</h1>
<p class="ur" lang="ur">مفت کا مطلب: آپ بنا سکتے ہیں</p>
<p class="sub">Every free tier for AI builders, dated and tracked.</p>
</body></html>"""
def icon(size, pad):
    return f"<html><body style='margin:0;width:{size}px;height:{size}px;background:#0B6E69;display:flex;align-items:center;justify-content:center'><div style='width:{size-2*pad}px;height:{size-2*pad}px'>{MARK.format(c='#FFFFFF')}</div></body></html>"
out = web / 'public'
with sync_playwright() as p:
    b = p.chromium.launch()
    for name, html, w, h in [('og.png', og, 1200, 630), ('logo-512.png', icon(512, 64), 512, 512), ('apple-touch-icon.png', icon(180, 22), 180, 180), ('favicon-32.png', icon(32, 2), 32, 32)]:
        pg = b.new_page(viewport={'width': w, 'height': h})
        f = pathlib.Path('/tmp/render.html'); f.write_text(html, encoding='utf-8'); pg.goto(f.as_uri()); pg.evaluate('document.fonts.ready'); pg.wait_for_timeout(800)
        pg.screenshot(path=str(out / name)); pg.close()
    b.close()
print('ok')
