#!/usr/bin/env bash
# Trace a raster logo source into SVG paths for src/assets/.
#
#   scripts/trace-logo.sh design/brand/logo-mark.png
#
# Requires: brew install potrace
#
# Writes <source>.svg next to the input. Open it, lift the path data into the
# matching component under src/assets/, and set fill to currentColor so the
# mark follows the theme. Do not import the raster source from src/ — it is a
# source file, not an asset.
set -euo pipefail

src="${1:?usage: scripts/trace-logo.sh <image>}"
[ -f "$src" ] || { echo "no such file: $src" >&2; exit 1; }
command -v potrace >/dev/null || { echo "potrace missing — brew install potrace" >&2; exit 1; }

out="${src%.*}.svg"

# mkbitmap: greyscale, high-pass filter to drop the paper texture, then
# threshold to bilevel. -x keeps the output at source resolution so fine
# bristle detail survives.
mkbitmap -f 4 -s 1 -t 0.45 -x -o "${src%.*}.pbm" "$src"
potrace --svg --alphamax 1.2 --opttolerance 0.35 --turdsize 8 \
        -o "$out" "${src%.*}.pbm"
rm -f "${src%.*}.pbm"

echo "wrote $out"
echo "Next: lift the path data into src/assets/, set fill=\"currentColor\","
echo "and delete any stray specks the paper texture left behind."
