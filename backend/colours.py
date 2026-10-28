"""Powder colours: what a job's colour looks like, for the swatch on its card.

BC only says a colour in words ("DULUX MONUMENT MATT", "Interpon D1000
Black Sable"), sometimes with a code. The library in powder_colours.json is
built from the Dulux and Interpon colour charts; colours set by hand on the
board are stored in the database and beat it. A job matches, in order: a
hand-set colour for its exact code or description, then a library code, then
the longest library colour name found as whole words in its description.
"""
import json
import re
from functools import lru_cache
from pathlib import Path

LIBRARY_PATH = Path(__file__).resolve().parent / "powder_colours.json"

# Names this short ("Red", "Sky") turn up inside other words and finishes, so
# they only match a description that is that name and nothing else.
_MIN_NAME_LEN = 4


def norm(text: str | None) -> str:
    """Upper case, letters and digits only: the key a colour is compared by."""
    return re.sub(r"[^A-Z0-9]", "", str(text or "").upper())


def _words(text: str | None) -> str:
    return " ".join(re.findall(r"[A-Z0-9]+", str(text or "").upper()))


@lru_cache(maxsize=1)
def _raw_cached(mtime: float) -> dict:
    try:
        return json.loads(LIBRARY_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _raw() -> dict:
    try:
        return _raw_cached(LIBRARY_PATH.stat().st_mtime)
    except OSError:
        return {}


def aliases() -> dict[frozenset, str]:
    """The shop's own names for a chart colour ("Black Satin"), as the set of
    words in it -> the chart code. Word order doesn't matter, so "Satin Black"
    is the same alias."""
    return {frozenset(_words(a["words"]).split()): norm(a["code"])
            for a in _raw().get("aliases", []) if a.get("words") and a.get("code")}


@lru_cache(maxsize=1)
def _library_cached(mtime: float) -> tuple[dict, ...]:
    raw = _raw()
    out = []
    for c in raw.get("colours", []):
        if not c.get("name") or not c.get("hex"):
            continue
        out.append({
            "brand": c.get("brand", ""),
            "range": c.get("range", ""),
            "code": c.get("code", ""),
            "name": c["name"],
            "finish": c.get("finish", ""),
            "hex": c["hex"],
        })
    return tuple(out)


def library() -> tuple[dict, ...]:
    try:
        mtime = LIBRARY_PATH.stat().st_mtime
    except OSError:
        return ()
    return _library_cached(mtime)


def colour_key(code: str | None, description: str | None) -> str:
    """What a hand-set colour is stored under: the code if BC gave one."""
    return norm(code) or norm(description)


class Matcher:
    """Resolves many jobs against one snapshot of the library and hand-set rows."""

    def __init__(self, manual: list[dict]):
        self.manual = {m["colour_key"]: m for m in manual}
        self.by_code: dict[str, dict] = {}
        self.by_name: dict[str, list[dict]] = {}
        for c in library():
            if c["code"]:
                self.by_code.setdefault(norm(c["code"]), c)
            self.by_name.setdefault(_words(c["name"]), []).append(c)
        # longest first, so "WHITE" doesn't win over "PEARL WHITE"
        self.names = sorted(
            (n for n in self.by_name if len(n.replace(" ", "")) >= _MIN_NAME_LEN),
            key=len, reverse=True,
        )
        self.aliases = aliases()
        self._cache: dict[tuple, dict | None] = {}

    def match(self, code: str | None, description: str | None) -> dict | None:
        key = (code or "", description or "")
        if key not in self._cache:
            self._cache[key] = self._match(code, description)
        return self._cache[key]

    def _match(self, code, description):
        for k in (norm(code), norm(description)):
            if k and k in self.manual:
                m = self.manual[k]
                return _out(m["colour_key"], m["name"], m.get("brand", ""), m.get("code", ""), m["hex"], "manual")
        words = _words(description)
        wanted = self.aliases.get(frozenset(w for w in words.split() if w not in _BRAND_ONLY))
        if wanted and wanted in self.by_code:
            target = self.by_code[wanted]
            padded = f" {words} "
            # "Interpon Black Satin" is Interpon's, not the shop's Dulux one
            other = any(f" {w} " in padded for b, ws in _BRAND_WORDS.items() if b != target["brand"] for w in ws)
            if not other:
                return _lib(target, "alias")
        for token in [norm(code)] + [norm(t) for t in words.split()]:
            if token and token in self.by_code:
                return _lib(self.by_code[token], "code")
        # RAL colours are a different standard that neither chart covers, and
        # "RAL 9010 PURE WHITE" is not the chart's White.
        if " RAL " in f" {words} ":
            return None
        core = " ".join(w for w in words.split() if w not in _NOISE)
        if core in self.by_name:
            return _lib(_best(self.by_name[core], words), "name")
        padded = f" {words} "
        for name in self.names:
            # a one-word name ("WHITE") is too common to find inside a longer
            # description; it has to be the whole of it, as checked just above
            if " " in name and f" {name} " in padded:
                return _lib(_best(self.by_name[name], words), "name")
        return None


# Brand and range words, which an alias ignores; the finish is part of an alias.
_BRAND_ONLY = {"DULUX", "DURALLOY", "INTERPON", "POWDER", "POWDERCOAT", "COAT", "RAPIDCURE"}

# Words a description carries around the colour's name: brand, range and finish.
_NOISE = {"DULUX", "DURALLOY", "INTERPON", "D2525", "D3020", "POWDER", "POWDERCOAT", "COAT",
          "MATT", "SATIN", "GLOSS", "FLAT", "TEXTURE", "LOW", "COLORBOND", "COLOURBOND", "RAPIDCURE"}

# Words in a description that point at one brand's version of a shared name.
_BRAND_WORDS = {"Dulux": ("DULUX", "DURALLOY"), "Interpon": ("INTERPON", "D2525", "D3020")}


def _best(candidates: list[dict], words: str) -> dict:
    """Monument is a Dulux Matt, a Dulux Satin and an Interpon colour or two:
    take the one whose brand and finish the description mentions, else the first."""
    padded = f" {words} "

    def score(c):
        s = 0
        if any(f" {b} " in padded for b in _BRAND_WORDS.get(c["brand"], ())):
            s += 2
        if c["finish"] and f" {_words(c['finish'])} " in padded:
            s += 1
        if "RAPIDCURE" not in padded and "RapidCure" in c.get("range", ""):
            s -= 1
        return s

    return max(candidates, key=score)


def _lib(c: dict, how: str) -> dict:
    key = "lib:" + norm(c["brand"]) + ":" + (norm(c["code"]) or norm(c["name"]))
    return _out(key, c["name"], c["brand"], c["code"], c["hex"], how)


def _out(key, name, brand, code, hex_, how) -> dict:
    return {"key": key, "name": name, "brand": brand, "code": code, "hex": hex_, "matched_by": how}
