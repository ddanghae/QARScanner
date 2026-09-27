import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewServer } from './preview-server.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.argv[2] ?? 8080);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('포트는 1024~65535 사이여야 합니다.');

createPreviewServer(root).listen(port, '127.0.0.1', () => {
  console.log(`QAR 미리보기: http://127.0.0.1:${port} · 종료하려면 Ctrl+C`);
});
