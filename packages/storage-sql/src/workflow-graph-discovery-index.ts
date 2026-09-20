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
