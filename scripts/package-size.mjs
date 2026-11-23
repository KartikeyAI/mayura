import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const limits = JSON.parse(await readFile(new URL('../compatibility/package-size-budget.json', import.meta.url), 'utf8'));

/** Enforce the budget using npm's measurements of the actual tarball. */
export function packageSize({ size, unpackedSize, entryCount }) {
  const measured = { compressedBytes: size, unpackedBytes: unpackedSize, files: entryCount };
  for (const [name, actual] of Object.entries(measured)) {
    assert(Number.isSafeInteger(limits[name]) && limits[name] > 0, `Invalid mayura package budget for ${name}.`);
    assert(Number.isSafeInteger(actual) && actual > 0, `Invalid npm pack measurement for ${name}.`);
    assert(actual <= limits[name], `Mayura archive ${name} is ${actual}, above the ${limits[name]} budget.`);
  }
  return measured;
}
