import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { popupCrop } from '../extension-runner/surface.mjs';

assert.equal(popupCrop([800, 80, 300, 400], [800, 80, 300, 400], 1366, 1000), '300x400+800+80');
for (const bounds of [[-1, 0, 300, 400], [0, 0, 0, 400], [1200, 0, 300, 400], [0, 900, 300, 400], [0.5, 0, 300, 400]]) {
  assert.throws(() => popupCrop(bounds, bounds, 1366, 1000));
}
assert.throws(() => popupCrop([800, 80, 300, 400], [800, 90, 300, 400], 1366, 1000), /moved/);
execFileSync('python3', ['-c', String.raw`
import sys
sys.path.insert(0, sys.argv[1])
from redaction import secret_boxes
component = (0, 0, 300, 400)
glyph = lambda index: (index * 10, 20, 10, 15)
assert secret_boxes('Settings', 'CV: resume.pdf', glyph, component, ['resume.pdf']) == [(32, 12, 148, 43)]
assert secret_boxes('', 'secret secret', glyph, component, ['secret']) == [(-8, 12, 68, 43), (62, 12, 138, 43)]
assert secret_boxes('', 'é秘密', glyph, component, ['秘密']) == [(2, 12, 38, 43)]
assert secret_boxes('secret', '', glyph, component, ['secret']) == [(-8, -8, 308, 408)]
assert secret_boxes('', 'secret', lambda _: (0, 0, -1, -1), component, ['secret']) == [(-8, -8, 308, 408)]
assert secret_boxes('', 'typed value', glyph, component, [], True) == [(-8, -8, 308, 408)]
assert secret_boxes('Settings', 'Language English', glyph, component, ['secret']) == []
`, new URL('../extension-runner', import.meta.url).pathname], { stdio: 'pipe' });
console.log('Native screenshot: fixed product bounds, complete secret glyph masking and conservative fallback pass');
