import { StorageError } from '@mayura/storage-contracts';
import type { SchedulerBackend, SchedulerSession } from './scheduler-database.js';

const name = 'mayura_workflow_owners_discovery';
const table = 'mayura_workflow_owners';
const columns = ['scope','policy_hash','profile','aggregate_id'] as const;
function invalid(): never { throw new StorageError('STORAGE_UNAVAILABLE','The workflow graph discovery index failed integrity validation.'); }

/**
 * A same-name index is not proof of a usable access path. Inspect bounded native
 * catalog metadata, never parsed DDL text, and leave incompatible objects intact.
 */
export async function initializeWorkflowGraphDiscoveryIndex(tx: SchedulerSession, backend: SchedulerBackend): Promise<void> {
  if (backend.dialect === 'mysql') {
    // MySQL has no CREATE INDEX IF NOT EXISTS; its key columns are VARBINARY, which already compare byte by byte.
    const statistics = `FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`;
    if ((await tx.query(`SELECT INDEX_NAME ${statistics} LIMIT 1`, [table, name])).length === 0) {
      await tx.query(`CREATE INDEX ${name} ON ${backend.prefix}${table} (${columns.join(',')})`);
    }
    const keys = await tx.query<{ ordinal: number | string; column_name: string; non_unique: number | string; sub_part: number | null; index_type: string; expression: string | null; direction: string | null }>(
      `SELECT SEQ_IN_INDEX AS ordinal, COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique, SUB_PART AS sub_part, INDEX_TYPE AS index_type,
        EXPRESSION AS expression, COLLATION AS direction ${statistics} ORDER BY SEQ_IN_INDEX LIMIT 5`, [table, name]);
    if (keys.length !== columns.length || keys.some((key, ordinal) => Number(key.ordinal) !== ordinal + 1 || key.column_name !== columns[ordinal]
      || Number(key.non_unique) !== 1 || key.sub_part !== null || key.index_type !== 'BTREE' || key.expression !== null || key.direction !== 'A')) invalid();
    const type = await tx.query<{ data_type: string }>(`SELECT DATA_TYPE AS data_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, 'aggregate_id']);
    if (type[0]?.data_type !== 'varbinary') invalid();
    return;
  }
  const collation = backend.dialect === 'postgres' ? '"C"' : 'BINARY';
  await tx.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${backend.prefix}${table}
    (scope,policy_hash,profile,aggregate_id COLLATE ${collation})`);
  if (backend.dialect === 'sqlite') {
    const indexes = await tx.query<{ name: string; unique: number; origin: string; partial: number }>(
      'SELECT name,"unique",origin,partial FROM pragma_index_list(?, \'main\') WHERE name = ? LIMIT 2',[table,name]);
    const index = indexes[0];
    if (indexes.length !== 1 || !index || index.unique !== 0 || index.origin !== 'c' || index.partial !== 0) invalid();
    const keys = await tx.query<{ seqno: number; cid: number; name: string | null; desc: number; coll: string | null }>(
      'SELECT seqno,cid,name,"desc",coll FROM pragma_index_xinfo(?, \'main\') WHERE key = 1 ORDER BY seqno LIMIT 5',[name]);
    if (keys.length !== columns.length || keys.some((key,ordinal) => key.seqno !== ordinal || key.cid < 0
      || key.name !== columns[ordinal] || key.desc !== 0 || key.coll?.toUpperCase() !== 'BINARY')) invalid();
    return;
  }
  const indexes = await tx.query<{ index_id: string; relkind: string; amname: string; indnatts: number; indnkeyatts: number;
    indisvalid: boolean; indisready: boolean; indislive: boolean; indisunique: boolean; indisexclusion: boolean;
    full_index: boolean; plain_columns: boolean }>(
    `SELECT i.indexrelid::text AS index_id,ix.relkind,am.amname,i.indnatts,i.indnkeyatts,
      i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indisexclusion,
      i.indpred IS NULL AS full_index,i.indexprs IS NULL AS plain_columns
      FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ix ON ix.oid = i.indexrelid
      JOIN pg_catalog.pg_class tab ON tab.oid = i.indrelid JOIN pg_catalog.pg_am am ON am.oid = ix.relam
      WHERE tab.oid = pg_catalog.to_regclass(?) AND ix.relnamespace = tab.relnamespace AND ix.relname = ? LIMIT 2`,
    [`${backend.prefix}${table}`,name]);
  const index = indexes[0];
  // indcheckxmin is deliberately not an integrity condition: PostgreSQL decides
  // HOT-chain visibility per snapshot, and this flag may remain true on a usable
  // valid index long after its older readers have ended.
  if (indexes.length !== 1 || !index || index.relkind !== 'i' || index.amname !== 'btree'
    || index.indnatts !== 4 || index.indnkeyatts !== 4 || !index.indisvalid || !index.indisready || !index.indislive
    || index.indisunique || index.indisexclusion || !index.full_index || !index.plain_columns) invalid();
  const keys = await tx.query<{ ordinal: number; attname: string; flags: number; native_collation: boolean; binary_collation: boolean; default_operator: boolean }>(
    `SELECT key.ordinal::integer AS ordinal,a.attname,key.flags,
      key.collation_oid = a.attcollation AS native_collation,
      key.collation_oid = 'pg_catalog."C"'::pg_catalog.regcollation AS binary_collation,
      (opc.opcdefault AND opc.opcintype = a.atttypid AND opc.opcmethod = ix.relam
        AND opc.opcnamespace = 'pg_catalog'::pg_catalog.regnamespace) AS default_operator
      FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ix ON ix.oid = i.indexrelid
      CROSS JOIN LATERAL ROWS FROM (pg_catalog.unnest(i.indkey::smallint[]),pg_catalog.unnest(i.indcollation::oid[]),
        pg_catalog.unnest(i.indclass::oid[]),pg_catalog.unnest(i.indoption::smallint[]))
        WITH ORDINALITY AS key(attnum,collation_oid,opclass_oid,flags,ordinal)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = key.attnum
      JOIN pg_catalog.pg_opclass opc ON opc.oid = key.opclass_oid
      WHERE i.indexrelid = ?::oid ORDER BY key.ordinal LIMIT 5`,[index.index_id]);
  if (keys.length !== columns.length || keys.some((key,ordinal) => key.ordinal !== ordinal + 1 || key.attname !== columns[ordinal]
    || key.flags !== 0 || !key.default_operator || !(ordinal === 3 ? key.binary_collation : key.native_collation))) invalid();
}
