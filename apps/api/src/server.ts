import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createApp, defaultOrigins } from './app.js';

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '127.0.0.1';
const mockDelayMs = Number(process.env.MOCK_DELAY_MS ?? 350);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('HOST must be a loopback address.');
if (!Number.isInteger(mockDelayMs) || mockDelayMs < 0 || mockDelayMs > 10000) throw new Error('MOCK_DELAY_MS must be an integer from 0 to 10000.');
const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : fileURLToPath(new URL('../.data/', import.meta.url));
const app = await createApp({
  dataDir, mockDelayMs, logger: true,
  origins: process.env.FRONTEND_ORIGINS === undefined ? defaultOrigins : process.env.FRONTEND_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean),
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.close().catch((error: unknown) => { app.log.error(error); process.exitCode = 1; });
  });
}
try { await app.listen({ port, host }); }
catch (error) { app.log.error(error); await app.close(); process.exitCode = 1; }
