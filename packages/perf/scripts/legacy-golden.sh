#!/usr/bin/env bash
# Rebuild the checked-in legacy slotexp golden fixtures from the read-only archive.
set -euo pipefail

archive_dir=${VALVE_EVIDENCE_ARCHIVE:-/home/xlr8/valve-evidence-archive/2026-10-19-pre-harness}
package_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fixture_dir="$package_dir/test/fixtures/legacy"
temporary_dir=$(mktemp -d)
trap 'rm -rf -- "$temporary_dir"' EXIT

tar --zstd -xf "$archive_dir/bench.tar.zst" -C "$temporary_dir" \
  bench/slotexp-validation/analyze.py \
  bench/slotexp-validation/raw/confirm.jsonl \
  bench/slotexp-validation/raw/decision-criteria.json

validation_dir="$temporary_dir/bench/slotexp-validation"
python3 - "$validation_dir/raw/confirm.jsonl" "$temporary_dir/cells.json" "$temporary_dir/confirm-subset.jsonl" <<'PY'
import json, pathlib, sys
source, cells_path, output = map(pathlib.Path, sys.argv[1:])
cells = []
selected = []
for line in source.read_text().splitlines():
    row = json.loads(line)
    cell = row['cell']
    if cell not in cells and len(cells) < 3:
        cells.append(cell)
    if cell in cells:
        selected.append(line)
cells_path.write_text(json.dumps(cells))
output.write_text('\n'.join(selected) + '\n')
PY

(cd "$validation_dir" && python3 analyze.py confirm)
mkdir -p "$fixture_dir"
cp "$temporary_dir/confirm-subset.jsonl" "$fixture_dir/confirm-subset.jsonl"
python3 - "$validation_dir/raw/analysis-confirm.json" "$temporary_dir/cells.json" "$fixture_dir/confirm-analysis.json" <<'PY'
import json, pathlib, sys
analysis_path, cells_path, output = map(pathlib.Path, sys.argv[1:])
analysis = json.loads(analysis_path.read_text())
cells = set(json.loads(cells_path.read_text()))
analysis['cells'] = {key: value for key, value in analysis['cells'].items() if value['cell'] in cells}
output.write_text(json.dumps(analysis, indent=2, sort_keys=True) + '\n')
PY

echo "wrote fixtures for $(python3 -c 'import json,sys; print(", ".join(json.load(open(sys.argv[1]))))' "$temporary_dir/cells.json")"
