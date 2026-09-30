// Test-only instrumentation: the conformance suites read and tamper with stored rows through a few simple SQL
// statements. This applies them to a document store's documents, table by table, through two raw hooks of the backend
// under test. It understands only the shapes the suites use:
//   SELECT <columns | *> FROM <table> [WHERE <column> = ? [AND ...]] [ORDER BY ...] [LIMIT <n>]
//   UPDATE <table> SET <column> = ? | <column> = <column> + 1 [, ...] WHERE <column> = ? [AND ...]
//   DELETE FROM <table> WHERE <column> = ? [AND ...]
//   INSERT INTO <table> (<columns>) VALUES (?, ...)
// where a `?` may also be an integer literal. Any other statement fails the test.
import { key, parts } from '../src/document/keys.js';
import type { StoredDocument } from '../src/document/session.js';

type Row = Record<string, unknown>;
/** A raw write: `body: null` deletes. The version is raised so that transactions holding the document conflict. */
export interface RawDocuments {
  scan(): Promise<readonly StoredDocument[]>;
  write(changes: readonly { partition: string; sort: string; body: string | null }[]): Promise<void>;
}
interface Place { partition: string; sort: string }
interface Table {
  /** Every row, with where it lives. `index` locates a row inside a document that holds several. */
  rows(documents: readonly StoredDocument[]): { row: Row; place: Place; index?: number }[];
  /** Where a new row goes. */
  place?(row: Row): Place;
  /** The document's new body once its rows changed, or null to delete it. */
  body?(rows: Row[], place: Place, before: string | undefined): string | null;
}
const kindOf = (document: StoredDocument) => parts(document.partition)[0];
const sortKind = (document: StoredDocument) => parts(document.sort)[0];
const single = (partitionKind: string, sortKind0: string, extra: (partition: string[], sort: string[]) => Row = () => ({})): Table => ({
  rows: documents => documents.filter(document => kindOf(document) === partitionKind && sortKind(document) === sortKind0)
    .map(document => ({ row: { ...JSON.parse(document.body) as Row, ...extra(parts(document.partition), parts(document.sort)) }, place: document })),
  body: (rows, place) => rows.length === 0 ? null : JSON.stringify(strip(rows[0]!, place)),
});
/** Columns the document keeps in its key, not its body. */
const derived = new Map<string, string[]>();
function strip(row: Row, place: Place): Row {
  const drop = derived.get(`${parts(place.partition)[0]}/${parts(place.sort)[0]}`) ?? [];
  return Object.fromEntries(Object.entries(row).filter(([column]) => !drop.includes(column)));
}
const list = (partitionKind: string, sortKind0: string, extra: (partition: string[], sort: string[]) => Row, place: (row: Row) => Place): Table => ({
  rows: documents => documents.filter(document => kindOf(document) === partitionKind && sortKind(document) === sortKind0)
    .flatMap(document => (JSON.parse(document.body) as { rows: Row[] }).rows.map((row, index) => ({ row: { ...row, ...extra(parts(document.partition), parts(document.sort)) }, place: document, index }))),
  place,
  body: rows => rows.length === 0 ? null : JSON.stringify({ rows }),
});
const withKeys = (names: string[], from: 'partition' | 'sort', offset: number) => (partition: string[], sort: string[]) =>
  Object.fromEntries(names.map((name, index) => [name, (from === 'partition' ? partition : sort)[offset + index]]));
const both = (...parts0: ((partition: string[], sort: string[]) => Row)[]) => (partition: string[], sort: string[]) => Object.assign({}, ...parts0.map(part => part(partition, sort))) as Row;
const numeric = (name: string, from: 'partition' | 'sort', index: number) => (partition: string[], sort: string[]) => ({ [name]: Number((from === 'partition' ? partition : sort)[index]) });

const tables: Record<string, Table> = {
  mayura_aggregates: single('run', 'r'),
  mayura_events: { rows: documents => documents.filter(document => kindOf(document) === 'run' && sortKind(document) === 'e')
    .flatMap(document => (JSON.parse(document.body) as { events: Row[] }).events.map((row, index) => ({ row: { ...row, scope: parts(document.partition)[1], aggregate_id: parts(document.partition)[2] }, place: document, index }))),
    body: rows => rows.length === 0 ? null : JSON.stringify({ events: rows.map(({ scope: _scope, aggregate_id: _id, ...row }) => row) }) },
  mayura_workflow_owners: single('run', 'o'),
  mayura_workflow_wait_targets: list('run', 'w', () => ({}), row => ({ partition: key('run', row['scope'] as string, row['aggregate_id'] as string), sort: key('w') })),
  mayura_workflow_jobs: single('run', 'l', withKeys(['scope', 'aggregate_id'], 'partition', 1)),
  mayura_scheduler_jobs: single('runjobs', 'j'),
  mayura_execution_completions: single('run', 'c'),
  mayura_execution_streams: single('stream', 's'),
  mayura_execution_waits: single('stream', 'w'),
  mayura_execution_wait_targets: list('stream', 't', () => ({}), row => ({ partition: key('stream', row['scope'] as string, row['stream_id'] as string), sort: key('t', row['wait_id'] as string) })),
  mayura_execution_wait_events: single('stream', 'e', both(withKeys(['scope', 'stream_id'], 'partition', 1))),
  mayura_durable_budgets: { ...single('budget', 'r'), rows: documents => single('budget', 'r').rows(documents.filter(document => parts(document.partition)[1] === 'durable_budget')) },
  mayura_durable_budget_events: { ...single('budget', 'e', both(withKeys(['scope', 'budget_id'], 'partition', 2), numeric('sequence', 'sort', 1))),
    rows: documents => single('budget', 'e', both(withKeys(['scope', 'budget_id'], 'partition', 2))).rows(documents.filter(document => parts(document.partition)[1] === 'durable_budget')) },
};
derived.set('run/e', ['scope', 'aggregate_id']); derived.set('run/l', ['scope', 'aggregate_id']); derived.set('stream/e', ['scope', 'stream_id']); derived.set('budget/e', ['scope', 'budget_id']);

function where(clause: string | undefined, parameters: unknown[]): Row {
  const filter: Row = {};
  if (!clause) return filter;
  for (const condition of clause.split(/\s+AND\s+/i)) {
    const match = /^([a-z_][a-z0-9_]*)\s*=\s*(\?|\d+)$/i.exec(condition.trim());
    if (!match) throw new Error(`The document test view cannot filter on: ${condition}`);
    filter[match[1]!] = match[2] === '?' ? parameters.shift() : Number(match[2]);
  }
  return filter;
}
const matches = (row: Row, filter: Row) => Object.entries(filter).every(([column, value]) => row[column] === value || String(row[column]) === String(value));

/** Raw SQL over a document store's documents, for the conformance suites' fault injection. */
export function documentSql(raw: RawDocuments) {
  return async (sql: string, values: readonly unknown[] = []): Promise<readonly Row[]> => {
    const text = sql.replace(/\s+/g, ' ').trim(); const parameters = [...values];
    const table = (name: string) => { const found = tables[name]; if (!found) throw new Error(`The document test view has no table ${name}.`); return found; };
    let match = /^SELECT (.+?) FROM ([a-z_][a-z0-9_]*)(?: WHERE (.+?))?(?: ORDER BY ([^ ]+(?:, ?[^ ]+)*))?(?: LIMIT (\d+))?$/i.exec(text);
    if (match) {
      const [, columns, name, clause, order, limit] = match as unknown as [string, string, string, string | undefined, string | undefined, string | undefined];
      const filter = where(clause, parameters);
      let rows = table(name).rows(await raw.scan()).map(item => item.row).filter(row => matches(row, filter));
      const keys = order && !/^\d/.test(order) ? order.split(/, ?/) : undefined;
      rows = rows.sort((a, b) => { const x = keys ? keys.map(column => a[column]) : Object.values(a); const y = keys ? keys.map(column => b[column]) : Object.values(b);
        const left = JSON.stringify(x); const right = JSON.stringify(y); return left < right ? -1 : left > right ? 1 : 0; });
      if (limit) rows = rows.slice(0, Number(limit));
      if (columns.trim() === '*') return rows;
      const names = columns.split(/, ?/).map(column => column.trim());
      return rows.map(row => Object.fromEntries(names.map(column => [column, row[column]])));
    }
    const rewrite = async (name: string, change: (rows: { row: Row; place: Place; index?: number }[]) => { place: Place; rows: Row[] }[]) => {
      const documents = await raw.scan();
      const updates = change(table(name).rows(documents));
      const changes = updates.map(update => {
        const before = documents.find(document => document.partition === update.place.partition && document.sort === update.place.sort)?.body;
        return { partition: update.place.partition, sort: update.place.sort, body: table(name).body!(update.rows, update.place, before) };
      });
      await raw.write(changes);
    };
    /** All rows of the documents that hold the selected rows, changed by `edit` (returning undefined drops a row). */
    const grouped = (all: { row: Row; place: Place; index?: number }[], selected: (row: Row) => boolean, edit: (row: Row) => Row | undefined) => {
      const byPlace = new Map<string, { place: Place; rows: { row: Row; hit: boolean }[] }>();
      for (const item of all) {
        const id = `${item.place.partition}\u0000${item.place.sort}`;
        if (!byPlace.has(id)) byPlace.set(id, { place: { partition: item.place.partition, sort: item.place.sort }, rows: [] });
        byPlace.get(id)!.rows.push({ row: item.row, hit: selected(item.row) });
      }
      return [...byPlace.values()].filter(group => group.rows.some(item => item.hit))
        .map(group => ({ place: group.place, rows: group.rows.flatMap(item => { if (!item.hit) return [item.row]; const next = edit(item.row); return next ? [next] : []; }) }));
    };
    match = /^UPDATE ([a-z_][a-z0-9_]*) SET (.+?) WHERE (.+)$/i.exec(text);
    if (match) {
      const [, name, assignments, clause] = match as unknown as [string, string, string, string];
      const set: Row = {}; const increments: string[] = [];
      for (const assignment of assignments.split(/, ?/)) {
        const value = /^([a-z_][a-z0-9_]*) = (\?|\d+)$/i.exec(assignment.trim());
        const increment = /^([a-z_][a-z0-9_]*) = ([a-z_][a-z0-9_]*) \+ 1$/i.exec(assignment.trim());
        if (value) set[value[1]!] = value[2] === '?' ? parameters.shift() : Number(value[2]);
        else if (increment && increment[1] === increment[2]) increments.push(increment[1]!);
        else throw new Error(`The document test view cannot assign: ${assignment}`);
      }
      const filter = where(clause, parameters);
      await rewrite(name, all => grouped(all, row => matches(row, filter), row => ({ ...row, ...set, ...Object.fromEntries(increments.map(column => [column, Number(row[column]) + 1])) })));
      return [];
    }
    match = /^DELETE FROM ([a-z_][a-z0-9_]*) WHERE (.+)$/i.exec(text);
    if (match) {
      const filter = where(match[2], parameters);
      await rewrite(match[1]!, all => grouped(all, row => matches(row, filter), () => undefined));
      return [];
    }
    match = /^INSERT INTO ([a-z_][a-z0-9_]*) ?\(([^)]+)\) VALUES ?\(([?, ]+)\)$/i.exec(text);
    if (match) {
      const name = match[1]!; const columns = match[2]!.split(/, ?/).map(column => column.trim());
      const row = Object.fromEntries(columns.map(column => [column, parameters.shift()]));
      const place = table(name).place?.(row); if (!place) throw new Error(`The document test view cannot insert into ${name}.`);
      await rewrite(name, all => {
        const existing = all.filter(item => item.place.partition === place.partition && item.place.sort === place.sort).map(item => item.row);
        return [{ place, rows: [...existing, row] }];
      });
      return [];
    }
    throw new Error(`The document test view has no translation for: ${text}`);
  };
}
