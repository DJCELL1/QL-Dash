"""Merge a colour-list CSV into backend/powder_colours.json.

Usage: python tools/import_colour_csv.py <colours.csv> backend/powder_colours.json [--brand Dulux]

The CSV needs columns Range, Colour Name, Finish, Product Code and Hex (the
Dulux Duratec list has these). Every range in the CSV replaces any colours the
library already holds under that range, so re-importing an updated list
doesn't leave the old copies behind; other ranges and the aliases are kept.
"""
import csv, json, re, sys

src, out_path = sys.argv[1], sys.argv[2]
brand = sys.argv[sys.argv.index("--brand") + 1] if "--brand" in sys.argv else "Dulux"

rows = list(csv.DictReader(open(src, encoding="utf-8-sig")))
new = []
for r in rows:
    name = (r.get("Colour Name") or "").replace("®", "").replace("™", "").strip()
    hexv = (r.get("Hex") or "").strip().upper()
    # codes sometimes carry a note after them: "9E38341F   (updated from July 26)"
    code = re.split(r"\s", (r.get("Product Code") or "").strip())[0]
    if not name or not re.fullmatch(r"#[0-9A-F]{6}", hexv):
        continue
    new.append({"brand": brand, "range": (r.get("Range") or "").strip(), "code": code,
                "name": name, "finish": (r.get("Finish") or "").strip(), "hex": hexv})

lib = json.load(open(out_path, encoding="utf-8"))
ranges = {c["range"] for c in new}
kept = [c for c in lib.get("colours", []) if c.get("range") not in ranges]
lib["colours"] = kept + new
json.dump(lib, open(out_path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
open(out_path, "a").write("\n")
print(f"{len(new)} colours from {len(ranges)} range(s); library now {len(lib['colours'])}")
