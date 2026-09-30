/**
 * The shared SQL layer writes SQLite and PostgreSQL DDL and queries; MySQL differs in ways a statement rewrite can
 * cover, and nothing else is changed:
 *
 * - `TEXT` cannot be indexed. Columns in a key or an index become `VARBINARY(256)` (identifiers are at most 256 UTF-8
 *   bytes, and bytes compare as SQLite's BINARY and PostgreSQL's "C" collation do, without padding); other text
 *   becomes `LONGTEXT`. Tables compare text as utf8mb4 code points (`utf8mb4_0900_bin`), never case-insensitively.
 * - `CREATE INDEX IF NOT EXISTS` does not exist, and partial indexes (`WHERE ...`) are not supported: the index is
 *   created when missing, over the whole table, which answers the same queries.
 * - Key columns are binary already, so `COLLATE` clauses are dropped; `CAST(... AS DOUBLE PRECISION)` is `DOUBLE`.
 */

/** Text columns the shared SQL layer indexes after creating their table; a key column in its own table is found by the translator. */
const INDEXED = new Set(['scope', 'id', 'status', 'sensitivity', 'record_id', 'from_id', 'to_id', 'embedder_id', 'job_id', 'resource_key',
  'policy_hash', 'aggregate_id', 'root_id', 'stream_id']);
export const KEY_TYPE = 'VARBINARY(256)';
export const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin';

/** Top-level comma-separated items of a parenthesized list. */
function items(body: string): string[] {
  const out: string[] = []; let depth = 0; let quoted = false; let start = 0;
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (character === "'") quoted = !quoted;
    else if (!quoted && character === '(') depth++;
    else if (!quoted && character === ')') depth--;
    else if (!quoted && depth === 0 && character === ',') { out.push(body.slice(start, index).trim()); start = index + 1; }
  }
  out.push(body.slice(start).trim());
  return out.filter(Boolean);
}
const names = (list: string) => list.split(',').map(name => name.trim().replace(/^"|"$/g, '').split(/\s+/)[0]!);

function createTable(sql: string): string {
  const open = sql.indexOf('('); const close = sql.lastIndexOf(')');
  if (open < 0 || close < open) return sql;
  const parts = items(sql.slice(open + 1, close));
  const keys = new Set<string>();
  for (const part of parts) {
    for (const match of part.matchAll(/(?:PRIMARY KEY|UNIQUE|FOREIGN KEY)\s*\(([^)]*)\)/gi)) for (const name of names(match[1]!)) keys.add(name);
  }
  const columns = parts.map(part => {
    const column = /^("?)([A-Za-z_][A-Za-z0-9_]*)\1\s+TEXT\b/i.exec(part);
    if (!column) return part;
    const name = column[2]!;
    return part.replace(/\bTEXT\b/i, keys.has(name) || INDEXED.has(name) ? KEY_TYPE : 'LONGTEXT');
  });
  return `${sql.slice(0, open)}(${columns.join(', ')}) ${TABLE_OPTIONS}`;
}

export type Statement = { readonly kind: 'sql'; readonly sql: string } | { readonly kind: 'index'; readonly name: string; readonly table: string; readonly sql: string };

/** The MySQL form of one statement from the shared SQL layer. */
export function translate(sql: string): Statement {
  const text = sql.trim();
  if (/^CREATE TABLE/i.test(text)) return { kind: 'sql', sql: createTable(text) };
  const index = /^CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+("?)([A-Za-z0-9_]+)\1\s+ON\s+("?)([A-Za-z0-9_."]+)\3\s*\(([^)]*)\)/i.exec(text);
  if (index) {
    const table = index[4]!.split('.').pop()!.replace(/"/g, '');
    const columns = names(index[5]!).join(', ');
    return { kind: 'index', name: index[2]!, table, sql: `CREATE INDEX ${index[2]} ON ${index[4]} (${columns})` };
  }
  return { kind: 'sql', sql: text.replace(/\s+COLLATE\s+(?:"C"|BINARY|utf8mb4_0900_bin)\b/gi, '').replace(/\bAS DOUBLE PRECISION\)/g, 'AS DOUBLE)') };
}
