"""Build backend/powder_colours.json from the Dulux Duralloy and Interpon colour charts.

Usage: python tools/extract_powder_colours.py <duralloy.pdf> <interpon.pdf> backend/powder_colours.json
Needs pdfplumber and pypdfium2, which the app itself does not.
"""
import json, re, sys, statistics
import pdfplumber, pypdfium2 as pdfium

dulux_pdf, interpon_pdf, out_path = sys.argv[1:4]
FINISHES = {"Matt", "Satin", "Gloss", "Texture", "Flat", "Low", "Semi", "Pearl", "Metallic"}
colours = []

def lines_of(words, tol=3):
    rows = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if rows and abs(rows[-1][0] - w["top"]) <= tol:
            rows[-1][1].append(w)
        else:
            rows.append([w["top"], [w]])
    return [(t, sorted(ws, key=lambda w: w["x0"])) for t, ws in rows]

# ---- Interpon: every tile prints its RGB
FIN = {"Matt", "Satin", "Gloss", "Texture", "Flat"}
last_range = ""
with pdfplumber.open(interpon_pdf) as pdf:
    for page in pdf.pages:
        words = page.extract_words(extra_attrs=["size"])
        # range headings are the big type; a heading can run over two lines
        heads = []
        for top, ws in lines_of([w for w in words if w["size"] > 20]):
            txt = " ".join(w["text"] for w in ws)
            if heads and top - heads[-1][0] < 45 and not txt.startswith("Interpon"):
                heads[-1] = (top, heads[-1][1] + " " + txt)
            elif txt.startswith("Interpon"):
                heads.append((top, txt))
        for rgb in [w for w in words if w["text"] == "RGB"]:
            x, top = rgb["x0"], rgb["top"]
            col = lambda w: x - 2 <= w["x0"] < x + 100
            same = sorted([w for w in words if col(w) and abs(w["top"] - top) <= 3 and w["x0"] > x], key=lambda w: w["x0"])
            nums_txt = "".join(w["text"] for w in same[: next((i for i, w in enumerate(same) if w["text"] == "LRV"), len(same))])
            nums = [int(n) for n in nums_txt.split(",") if n.isdigit()]
            codeline = sorted([w for w in words if col(w) and top - 15 <= w["top"] <= top - 4], key=lambda w: w["x0"])
            nameline = sorted([w for w in words if col(w) and top - 26 <= w["top"] < top - 15 + 0.5 and w not in codeline], key=lambda w: w["x0"])
            code_w = next((w for w in codeline if re.fullmatch(r"[Y8][A-Z0-9]{5}", w["text"])), None)
            if not code_w:
                continue
            pre = [w["text"] for w in codeline if w["x0"] < code_w["x0"]]
            fin = []
            while pre and pre[-1] in FIN:
                fin.insert(0, pre.pop())
            name = " ".join([w["text"] for w in nameline] + pre).replace("®", "").replace("™", "").strip()
            above = [h for h in heads if h[0] < top]
            rng = above[-1][1] if above else last_range
            if len(nums) == 3 and name:
                colours.append({"brand": "Interpon", "range": rng, "code": code_w["text"], "name": name,
                                "finish": " ".join(fin), "hex": "#%02X%02X%02X" % tuple(nums)})
        if heads:
            last_range = heads[-1][1]

# ---- Dulux Duralloy: the swatch is a picture with the label printed on it, and
# a tile can break across two pages, so labels are gathered column by column.
pdoc = pdfium.PdfDocument(dulux_pdf)
pending = {}
with pdfplumber.open(dulux_pdf) as pdf:
    for pi, page in enumerate(pdf.pages):
        text = page.extract_text() or ""
        words = page.extract_words()
        ppage = pdoc[pi]
        scale = 2
        bmp = ppage.render(scale=scale).to_pil().convert("RGB")
        imgs = [im for im in page.images if (im["x1"] - im["x0"]) > 100 and abs((im["x1"] - im["x0"]) - (im["bottom"] - im["top"]) * 1.65) < 30]
        for im in sorted(imgs, key=lambda i: (i["top"], i["x0"])):
            inside = [w for w in words if im["x0"] <= w["x0"] < im["x1"] and max(im["top"], 0) <= w["top"] < im["bottom"]]
            lines = [" ".join(w["text"] for w in ws) for _, ws in lines_of(inside)]
            lines = [l for l in lines if "Add to Cart" not in l and l != "+"]
            colkey = round(im["x0"])
            # sample a patch at the tile's right-hand side, clear of the label
            x0 = int((im["x1"] - 30) * scale); x1 = int((im["x1"] - 10) * scale)
            ys = int(max(im["top"], 0) * scale) + 10; ye = int(min(im["bottom"], page.height) * scale) - 10
            px = [bmp.getpixel((x, y)) for x in range(x0, x1, 2) for y in range(ys, ye, 3)]
            hexv = "#%02X%02X%02X" % tuple(int(statistics.median(c[i] for c in px)) for i in range(3)) if px else None
            part = pending.pop(colkey, {"lines": [], "hex": hexv}) if im["top"] < 0 else {"lines": [], "hex": hexv}
            part["lines"] += lines
            if part["hex"] is None:
                part["hex"] = hexv
            code = next((l for l in part["lines"] if re.fullmatch(r"\d{4}[0-9A-Z]{4}", l)), None)
            if im["bottom"] > page.height + 1 and not code:
                pending[colkey] = part
                continue
            if not code:
                continue
            idx = part["lines"].index(code)
            before = part["lines"][:idx]
            finish = before[-1] if before and before[-1].split()[0] in FINISHES else ""
            name = " ".join(before[:-1] if finish else before).replace("®", "").replace("™", "").strip()
            if name and part["hex"]:
                colours.append({"brand": "Dulux", "range": "Duralloy RapidCure" if code.startswith("26") else "Duralloy", "code": code, "name": name, "finish": finish, "hex": part["hex"]})

# the shop's aliases are typed in by hand, so carry them over from the old file
try:
    aliases = json.load(open(out_path)).get("aliases", [])
except (OSError, ValueError):
    aliases = []
json.dump({"source": "Dulux Duralloy Solid Colour Range and Interpon D2525/D3020 Commercial Collection charts",
           "aliases": aliases, "colours": colours}, open(out_path, "w"), indent=1, ensure_ascii=False)
from collections import Counter
print(Counter((c["brand"], c["range"]) for c in colours))
