import { readFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const accepted = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-3-Clause',
  'MIT OR Apache-2.0',
  'ISC',
  '0BSD',
  'BlueOak-1.0.0',
]);
let failed = false;
for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!path) continue;
  console.log(`${path}\t${entry.version}\t${entry.license ?? 'UNKNOWN'}`);
  if (!accepted.has(entry.license)) failed = true;
}
if (failed) {
  console.error(
    'Review missing or new dependency license metadata before accepting this lockfile.',
  );
  process.exitCode = 1;
}
