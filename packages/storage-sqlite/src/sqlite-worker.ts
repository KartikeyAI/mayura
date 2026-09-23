import { parentPort, workerData } from 'node:worker_threads';
import { storageError, StorageError, type CreateRecord, type UpdateRecord, type ExecutionWaitMethod, type WorkflowGraphStore, type WorkflowGraphDiscoveryStore, type DurableBudgetMethod, type WorkflowTreeMethod } from '@mayura/storage-contracts';
import { SqliteDatabase } from './sqlite-database.js';
import { identifier, cursor, type SchedulerMethod, type ScheduledMethod } from '@mayura/storage-sql/host';

interface Request { id: number; method: string; args: unknown[] }
const port = parentPort;
if (!port) throw new Error('SQLite storage worker requires a parent channel.');
let database: SqliteDatabase | undefined;
let initialized = false;

// Serialize entire requests: scheduler transactions contain awaited internal SQL steps.
// Letting a second message enter halfway through one would break transaction ownership.
let serial = Promise.resolve();
port.on('message', (request: Request) => { serial = serial.then(async () => {
  try {
    let result: unknown;
    if (request.method === 'initialize') {
      if (!initialized) {
        database = new SqliteDatabase((workerData as { filename: string }).filename);
        try { database.initialize(); initialized = true; }
        catch (error) { database.close(); database = undefined; throw error; }
      }
    } else if (request.method === 'close') {
      database?.close(); database = undefined; initialized = false;
    } else {
      if (!initialized || !database) throw new StorageError('STORE_NOT_INITIALIZED', 'Initialize storage before accessing records.');
      switch (request.method) {
        case 'scheduler': result = await database.schedulerCommand(request.args[0] as SchedulerMethod, request.args[1]); break;
        case 'workflows': result = await database.workflowsCommand(request.args[0] as ScheduledMethod, request.args[1]); break;
        case 'workflowGraphs': result = await database.workflowGraphsCommand(request.args[0] as keyof WorkflowGraphStore, request.args[1]); break;
        case 'workflowGraphDiscovery': result = await database.workflowGraphDiscoveryCommand(request.args[0] as keyof WorkflowGraphDiscoveryStore, request.args[1]); break;
        case 'executionWaits': result = await database.executionWaitsCommand(request.args[0] as ExecutionWaitMethod, request.args[1]); break;
        case 'durableBudgets': result = await database.durableBudgetsCommand(request.args[0] as DurableBudgetMethod, request.args[1]); break;
        case 'workflowTrees': result = await database.workflowTreesCommand(request.args[0] as WorkflowTreeMethod, request.args[1]); break;
        case 'create': result = database.create(request.args[0] as CreateRecord); break;
        case 'update': result = database.update(request.args[0] as UpdateRecord); break;
        case 'read': result = database.read(identifier(request.args[0], 'Scope'), identifier(request.args[1], 'Record ID')); break;
        case 'events': result = database.events(identifier(request.args[0], 'Scope'), identifier(request.args[1], 'Record ID'), cursor(request.args[2] as number)); break;
        default: throw new StorageError('INVALID_INPUT', 'Unknown storage command.');
      }
    }
    port.postMessage({ id: request.id, result });
    if (request.method === 'close') port.close();
  } catch (error) {
    const safe = storageError(error);
    port.postMessage({ id: request.id, error: { code: safe.code, message: safe.message } });
  }
}); });
