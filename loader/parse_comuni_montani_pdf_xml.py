#!/usr/bin/env python3
"""
Parse pdftohtml -xml output for the L. 131/2025 «comuni montani» ministerial-style PDF.
Many releases split the grid: first pages list numero/regione/provincia/sigla, later pages list
only the comune column in the same global order. Rows are zipped by document order.

Output: CSV to stdout with header sigla,comune
"""
from __future__ import annotations

import csv
import re
import sys
import xml.etree.ElementTree as ET


def _norm_sigla(s: str) -> bool:
    s = s.strip().upper()
    return len(s) == 2 and s.isalpha()


def _group_page(page: ET.Element, text_tag: str) -> dict[str, list[tuple[int, str]]]:
    by_top: dict[str, list[tuple[int, str]]] = {}
    for el in page.iter(text_tag):
        top, left = el.attrib.get("top"), el.attrib.get("left")
        if top is None or left is None:
            continue
        raw = (el.text or "").strip()
        if not raw:
            continue
        by_top.setdefault(top, []).append((int(left), raw))
    return by_top


def _classify_page(by_top: dict[str, list[tuple[int, str]]]) -> str:
    tops = sorted(by_top, key=lambda x: int(x))
    if not tops:
        return "empty"
    for top in tops[:8]:
        parts = [t for _, t in sorted(by_top[top], key=lambda z: z[0])]
        joined = " | ".join(parts)
        if "PROVINCIA_25" in joined or (parts and parts[0] == "Numero"):
            return "meta"
        if any("COMUNE" in p.upper() for p in parts) and "PROVINCIA_25" not in joined and "REGIONE" not in joined:
            return "comuni"
    for top in tops:
        parts = [t for _, t in sorted(by_top[top], key=lambda z: z[0])]
        if not parts or parts[0] == "Numero":
            continue
        if (
            len(parts) == 4
            and re.fullmatch(r"\d+", parts[0].strip())
            and _norm_sigla(parts[-1])
        ):
            return "meta"
        if len(parts) == 1:
            return "comuni"
    return "mixed"


def extract_rows(root: ET.Element) -> list[tuple[str, str]]:
    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0][1:]
    page_tag = f"{{{ns}}}page" if ns else "page"
    text_tag = f"{{{ns}}}text" if ns else "text"

    # Newer PDF layouts embed SIGLA + COMUNE on the same row.
    direct_pairs: list[tuple[str, str]] = []

    meta: list[str] = []
    comuni: list[str] = []

    for page in root.iter(page_tag):
        by_top = _group_page(page, text_tag)
        kind = _classify_page(by_top)
        tops = sorted(by_top, key=lambda x: int(x))
        # First try: extract pairs directly from any "tabular" row.
        # Example parts: ["1","Abruzzo","Chieti","CH","Bomba"]
        for top in tops:
            row = sorted(by_top[top], key=lambda x: x[0])
            parts = [t for _, t in row]
            if not parts or parts[0] == "Numero":
                continue
            if not re.fullmatch(r"\d+", parts[0].strip()):
                continue
            sigla_idx = None
            for i, p in enumerate(parts):
                if _norm_sigla(p):
                    sigla_idx = i
            if sigla_idx is not None and sigla_idx < len(parts) - 1:
                sigla = parts[sigla_idx].strip().upper()
                comune = " ".join(x.strip() for x in parts[sigla_idx + 1 :] if x.strip())
                if comune and comune.upper() != "COMUNE":
                    direct_pairs.append((sigla, comune))

        if kind == "meta":
            for top in tops:
                row = sorted(by_top[top], key=lambda x: x[0])
                parts = [t for _, t in row]
                if parts and parts[0] == "Numero":
                    continue
                if (
                    len(parts) == 4
                    and re.fullmatch(r"\d+", parts[0].strip())
                    and _norm_sigla(parts[-1])
                ):
                    meta.append(parts[-1].strip().upper())
        elif kind == "comuni":
            for top in tops:
                row = sorted(by_top[top], key=lambda x: x[0])
                parts = [t for _, t in row]
                if len(parts) != 1:
                    continue
                txt = parts[0]
                if txt.upper() == "COMUNE":
                    continue
                if int(top) > 1100 and re.fullmatch(r"\d+\s*", txt):
                    continue
                comuni.append(txt)

    if direct_pairs:
        uniq: dict[tuple[str, str], None] = {}
        for sigla, comune in direct_pairs:
            uniq[sigla.strip().upper(), comune.strip()] = None
        rows = sorted(uniq.keys(), key=lambda x: (x[0], x[1].lower()))
        return rows

    if len(meta) != len(comuni):
        print(
            f"error: mismatch meta_rows={len(meta)} comuni_rows={len(comuni)}",
            file=sys.stderr,
        )
        sys.exit(1)
    if len(meta) == 0:
        print("error: no rows extracted (unexpected PDF layout)", file=sys.stderr)
        sys.exit(1)

    pairs: list[tuple[str, str]] = list(zip(meta, comuni))
    uniq: dict[tuple[str, str], None] = {}
    for sigla, comune in pairs:
        uniq[sigla, comune] = None
    return sorted(uniq.keys(), key=lambda x: (x[0], x[1].lower()))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(
            "usage: parse_comuni_montani_pdf_xml.py path/to/pdftohtml-output.xml",
            file=sys.stderr,
        )
        return 2
    tree = ET.parse(argv[1])
    rows = extract_rows(tree.getroot())
    w = csv.writer(sys.stdout, lineterminator="\n")
    w.writerow(["sigla", "comune"])
    for sigla, comune in rows:
        w.writerow([sigla, comune])
    print(f"wrote_unique_rows:{len(rows)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
