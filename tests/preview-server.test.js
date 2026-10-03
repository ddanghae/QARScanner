import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewServer } from '../scripts/preview-server.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const server = createPreviewServer(root);
let baseUrl;

before(async () => {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
});

test('preview serves app entry and assets with content types', async () => {
  const [html, script, css] = await Promise.all([
    fetch(`${baseUrl}/`), fetch(`${baseUrl}/js/main.js`), fetch(`${baseUrl}/css/style.css`),
  ]);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /QAR/);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('preview serves the user-facing chart pattern guide', async () => {
  const guide = await fetch(`${baseUrl}/docs/CHART-PATTERNS.md`);
  assert.equal(guide.status, 200);
  assert.match(guide.headers.get('content-type'), /markdown/);
  assert.match(await guide.text(), /하모닉/);
});

test('preview does not expose research runs or project files', async () => {
  const privateRun = await fetch(`${baseUrl}/lab-runs/latest.json`);
  const privateProjectFile = await fetch(`${baseUrl}/AGENTS.md`);
  assert.equal(privateRun.status, 404);
  assert.equal(privateProjectFile.status, 404);
});

test('preview serves the W view and ES modules without exposing research notes', async () => {
  for (const path of ['/w-radar.html', '/css/w-radar.css', '/js/ui/w-radar.js', '/js/core/w-pattern.js', '/js/core/w-scan-state.js', '/js/ui/w-radar-tab.js']) {
    const response = await fetch(baseUrl + path);
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 100);
  }
  assert.equal((await fetch(baseUrl + '/docs/W-PATTERN.md')).status, 404);
  assert.equal((await fetch(baseUrl + '/.git/config')).status, 404);
});

test('preview serves the independent Cup & Handle scanner and detector', async () => {
  for (const path of ['/cup-radar.html', '/css/cup-radar.css', '/js/ui/cup-radar.js', '/js/core/cup-handle.js', '/js/ui/cup-radar-tab.js']) {
    const response = await fetch(baseUrl + path);
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 100);
  }
});
