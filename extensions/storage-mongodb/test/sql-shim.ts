// Test-only instrumentation: the conformance suites read and tamper with stored rows through a few simple SQL
// statements. This applies them to the same MongoDB documents. It understands only the shapes the suites use:
//   SELECT <columns | *> FROM <table> [WHERE <column> = ? [AND ...]] [ORDER BY ...] [LIMIT <n>]
//   UPDATE <table> SET <column> = ? | <column> = <column> + 1 [, ...] WHERE <column> = ? [AND ...]
//   DELETE FROM <table> WHERE <column> = ? [AND ...]
//   INSERT INTO <table> (<columns>) VALUES (?, ...)
// Any other statement fails the test.
import { MongoClient, type Document } from 'mongodb';

/** Collections whose documents name fields in camelCase; the rest use the SQL column names. */
const camel = new Set(['mayura_aggregates', 'mayura_events', 'mayura_durable_budgets', 'mayura_durable_budget_events']);
const field = (table: string, column: string) => camel.has(table) ? column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) : column;
const identifier = /^[a-z_][a-z0-9_]*$/;

function where(table: string, clause: string | undefined, parameters: unknown[]): Document {
  const filter: Document = {};
  if (!clause) return filter;
  for (const condition of clause.split(/\s+AND\s+/i)) {
    const match = /^([a-z_][a-z0-9_]*)\s*=\s*\?$/i.exec(condition.trim());
    if (!match) throw new Error(`The MongoDB test shim cannot filter on: ${condition}`);
    filter[field(table, match[1]!)] = parameters.shift();
  }
  return filter;
}
/** A document as the SQL row the suites expect: SQL column names, without MongoDB's and the store's bookkeeping fields. */
function rowOf(table: string, document: Document): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key === '_id' || key === 'mayuraLocks') continue;
    row[camel.has(table) ? key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`) : key] = value;
  }
  return row;
}

export function mongoSql(uri: string, database: string) {
  return async (sql: string, values: readonly unknown[] = []): Promise<readonly Record<string, unknown>[]> => {
    const text = sql.replace(/\s+/g, ' ').trim(); const parameters = [...values];
    const client = new MongoClient(uri);
    try {
      const db = client.db(database);
      let match = /^SELECT (.+?) FROM ([a-z_][a-z0-9_]*)(?: WHERE (.+?))?(?: ORDER BY ([^ ]+(?:, ?[^ ]+)*))?(?: LIMIT (\d+))?$/i.exec(text);
      if (match) {
        const [, columns, table, clause, order, limit] = match as unknown as [string, string, string, string | undefined, string | undefined, string | undefined];
        let cursor = db.collection(table).find(where(table, clause, parameters));
        // ORDER BY a column sorts by it; ORDER BY position keeps insertion order, stable between two reads.
        cursor = cursor.sort(order && !/^\d/.test(order) ? Object.fromEntries(order.split(/, ?/).map(column => [field(table, column), 1])) : { _id: 1 });
        if (limit) cursor = cursor.limit(Number(limit));
        const rows = (await cursor.toArray()).map(document => rowOf(table, document));
        if (columns.trim() === '*') return rows;
        const names = columns.split(/, ?/).map(column => column.trim());
        if (names.some(name => !identifier.test(name))) throw new Error(`The MongoDB test shim cannot select: ${columns}`);
        return rows.map(row => Object.fromEntries(names.map(name => [name, row[name]])));
      }
      match = /^UPDATE ([a-z_][a-z0-9_]*) SET (.+?) WHERE (.+)$/i.exec(text);
      if (match) {
        const [, table, assignments, clause] = match as unknown as [string, string, string, string];
        const set: Document = {}; const inc: Document = {};
        for (const assignment of assignments.split(/, ?/)) {
          const value = /^([a-z_][a-z0-9_]*) = \?$/i.exec(assignment.trim());
          const increment = /^([a-z_][a-z0-9_]*) = ([a-z_][a-z0-9_]*) \+ 1$/i.exec(assignment.trim());
          if (value) set[field(table, value[1]!)] = parameters.shift();
          else if (increment && increment[1] === increment[2]) inc[field(table, increment[1]!)] = 1;
          else throw new Error(`The MongoDB test shim cannot assign: ${assignment}`);
        }
        await db.collection(table).updateMany(where(table, clause, parameters), { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(inc).length ? { $inc: inc } : {}) });
        return [];
      }
      match = /^DELETE FROM ([a-z_][a-z0-9_]*) WHERE (.+)$/i.exec(text);
      if (match) { await db.collection(match[1]!).deleteMany(where(match[1]!, match[2], parameters)); return []; }
      match = /^INSERT INTO ([a-z_][a-z0-9_]*) ?\(([^)]+)\) VALUES ?\(([?, ]+)\)$/i.exec(text);
      if (match) {
        const table = match[1]!; const columns = match[2]!.split(/, ?/).map(column => column.trim());
        if (columns.length !== match[3]!.split(',').length || columns.some(column => !identifier.test(column))) throw new Error(`The MongoDB test shim cannot insert: ${text}`);
        await db.collection(table).insertOne(Object.fromEntries(columns.map(column => [field(table, column), parameters.shift()])));
        return [];
      }
      throw new Error(`The MongoDB test shim has no translation for: ${text}`);
    } finally { await client.close(); }
  };
}
