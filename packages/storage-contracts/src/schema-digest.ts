import { jsonSchemaOf, jsonValue, MayuraError, type JsonObject, type Schema } from '@mayura/core';
import { sha256Hex } from '@mayura/core/host';
import { workflowHashMaterial } from './workflow-format2.js';

/** @internal Synchronous SHA-256 of UTF-8 text, as lowercase hex (the shared implementation in core). */
export { sha256Hex };

/**
 * The SHA-256 digest (64 lowercase hex characters) that pins a schema into durable records, such as the response a
 * human request accepts or the body a webhook trigger admits. Pass a validator that can describe itself as JSON Schema
 * (Zod 4.2 and later can), or the JSON Schema object itself. The digest covers canonical JSON, so key order does not
 * change it. A validator that cannot describe itself is refused with INVALID_CONFIG.
 *
 * A derived digest follows the JSON Schema the validator produces: if a library upgrade changes that JSON Schema, the
 * digest (and a definition that contains it) changes too, like any other definition change.
 */
export function schemaDigest(schema: Schema | JsonObject): string {
  let described: JsonObject | undefined;
  if (schema !== null && typeof schema === 'object' && '~standard' in schema) {
    described = jsonSchemaOf(schema as Schema);
    if (described === undefined) {
      throw new MayuraError('INVALID_CONFIG', 'This validator cannot describe itself as JSON Schema, so its schema digest cannot be derived. '
        + 'Pass its JSON Schema object to schemaDigest, or give the 64-hex schemaDigest explicitly.');
    }
  } else {
    let copy: unknown;
    try { copy = jsonValue(schema, { maxBytes: 262_144, maxDepth: 64 }); } catch { copy = undefined; }
    if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) {
      throw new MayuraError('INVALID_CONFIG', 'schemaDigest needs a validator or a JSON Schema object of at most 256 KiB.');
    }
    described = copy as JsonObject;
  }
  return sha256Hex(workflowHashMaterial('mayura:schema-digest:v1', described));
}
