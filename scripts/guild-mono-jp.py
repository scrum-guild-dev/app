"""PlemolJP の TTF から、画面と見本が読む Guild Mono JP の woff2 と @font-face の CSS を作る。

PlemolJP は OFL の予約フォント名（Reserved Font Name）を持つ。形式の変換と文字の分割は OFL の Modified Version に
あたり、予約名を名乗れないので、書体の中の名前を Guild Mono JP に替える。著作権とライセンスの欄（name ID 0、13、14）は残す。

文字の範囲の区切りは、@fontsource/biz-udpgothic の CSS（Google Fonts の日本語の区切り）から借りる。どの区切りにも
入らない PlemolJP の文字は、最後の1ファイルにまとめる。

使い方（fontTools と brotli が要る。docs/development.md の「書体」）:
  python3 -I scripts/guild-mono-jp.py <PlemolJP の TTF のフォルダ> <区切りを読む CSS> <書き出すフォルダ>
"""

import re
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

FAMILY = 'Guild Mono JP'
SLUG = 'guild-mono-jp'
RESERVED = 'PlemolJP'
WEIGHTS = {400: 'Regular', 700: 'Bold'}
# PlemolJP は全角の空白を点線の四角で見せる（コードの中で見つけるため）。画面では空白に見せたいので、
# Guild Mono JP から外し、後ろの書体（端末のゴシック）で組ませる
EXCLUDED = {0x3000}
# 書体の名前を表す欄。著作権（0）、ライセンス（13、14）は書き換えない
NAME_IDS_TO_RENAME = {1, 3, 4, 6, 16, 17, 18, 21, 22}


def parse_ranges(css: str) -> list[set[int]]:
    slices = []
    for block in re.findall(r'unicode-range:\s*([^;]+);', css):
        codepoints = set()
        for part in block.split(','):
            part = part.strip().removeprefix('U+').removeprefix('u+')
            if '?' in part:
                start, end = int(part.replace('?', '0'), 16), int(part.replace('?', 'F'), 16)
            elif '-' in part:
                start, end = (int(x, 16) for x in part.split('-'))
            else:
                start = end = int(part, 16)
            codepoints.update(range(start, end + 1))
        slices.append(codepoints)
    return slices


def to_unicode_range(codepoints: list[int]) -> str:
    parts = []
    start = prev = codepoints[0]
    for cp in codepoints[1:] + [None]:
        if cp is not None and cp == prev + 1:
            prev = cp
            continue
        parts.append(f'U+{start:x}' if start == prev else f'U+{start:x}-{prev:x}')
        if cp is not None:
            start = prev = cp
    return ','.join(parts)


def rename(font: TTFont) -> None:
    for record in font['name'].names:
        if record.nameID not in NAME_IDS_TO_RENAME:
            continue
        text = record.toUnicode()
        # PostScript 名（6）は空白を持てない
        replacement = FAMILY.replace(' ', '') if record.nameID == 6 else FAMILY
        record.string = text.replace(RESERVED, replacement)
    leftover = [r.nameID for r in font['name'].names if r.nameID in NAME_IDS_TO_RENAME and RESERVED in r.toUnicode()]
    if leftover:
        raise SystemExit(f'予約名が残った name ID: {leftover}')


def build_slice(ttf: Path, codepoints: list[int], out: Path) -> None:
    options = subset.Options()
    options.flavor = 'woff2'
    options.hinting = False
    options.name_IDs = ['*']
    options.name_languages = ['*']
    options.notdef_outline = True
    font = subset.load_font(str(ttf), options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    rename(font)
    subset.save_font(font, str(out), options)


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    src_dir, ranges_css, out_dir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    slices = parse_ranges(ranges_css.read_text(encoding='utf-8'))
    files_dir = out_dir / SLUG
    files_dir.mkdir(parents=True, exist_ok=True)
    faces = []
    for weight, style in WEIGHTS.items():
        ttf = src_dir / f'{RESERVED}-{style}.ttf'
        cmap = set(TTFont(str(ttf), lazy=True).getBestCmap()) - EXCLUDED
        covered: set[int] = set()
        groups = []
        for codepoints in slices:
            groups.append(sorted(codepoints & cmap))
            covered |= codepoints
        groups.append(sorted(cmap - covered))
        for index, codepoints in enumerate(g for g in groups if g):
            name = f'{SLUG}-{weight}-{index}.woff2'
            build_slice(ttf, codepoints, files_dir / name)
            faces.append(
                '@font-face {\n'
                f"  font-family: '{FAMILY}';\n"
                '  font-style: normal;\n'
                f'  font-weight: {weight};\n'
                '  font-display: swap;\n'
                f"  src: url('./{SLUG}/{name}') format('woff2');\n"
                f'  unicode-range: {to_unicode_range(codepoints)};\n'
                '}\n'
            )
    header = (
        '/* Guild Mono JP: PlemolJP（Copyright (c) 2021, Yuko OTAWARA、SIL Open Font License 1.1）を\n'
        '   文字の範囲で分けた woff2。scripts/guild-mono-jp.py が作る。手で直さない。ライセンスは ./guild-mono-jp/OFL.txt */\n'
    )
    (out_dir / f'{SLUG}.css').write_text(header + '\n'.join(faces), encoding='utf-8')


if __name__ == '__main__':
    main()
