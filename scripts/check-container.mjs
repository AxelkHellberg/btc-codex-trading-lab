import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

// Inspect compiled modules and runtime dependencies without starting the trader.
await access('/app/dist/index.js', constants.R_OK);
for (const name of [
  'fastify', 'pg', 'ioredis', 'ws', 'rss-parser', '@openai/codex-sdk',
  '/app/dist/domain/schemas.js', '/app/dist/services/riskEngine.js'
]) {
  await import(name);
}
console.log('Container runtime modules are available');
