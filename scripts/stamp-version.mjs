#!/usr/bin/env node
// Stamps a content-hash version onto the scheduler.js <script src> in embed.html
// so a fresh deploy busts the browser cache immediately (no hard refresh).
// The stamped ?v= is reused by scheduler.js to version scheduler.css too.
//
// Run automatically by the git pre-commit hook, or manually: `node scripts/stamp-version.mjs`.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const hash = createHash('sha256')
  .update(readFileSync(join(docs, 'scheduler.js')))
  .update(readFileSync(join(docs, 'scheduler.css')))
  .digest('hex')
  .slice(0, 8);

const embedPath = join(docs, 'embed.html');
const embed = readFileSync(embedPath, 'utf8');
const next = embed.replace(/scheduler\.js\?v=[A-Za-z0-9]+/g, `scheduler.js?v=${hash}`);

if (next === embed) {
  console.log(`stamp-version: unchanged (v=${hash})`);
} else {
  writeFileSync(embedPath, next);
  console.log(`stamp-version: embed.html -> scheduler.js?v=${hash}`);
}
