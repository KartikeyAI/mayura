import { parentPort, workerData } from 'node:worker_threads';
import { storageError, StorageError, type CreateRecord, type UpdateRecord } from './contracts.js';
import { SqliteDatabase } from './sqlite-database.js';
import { identifier, cursor } from './validation.js';

interface Request { id: number; method: string; args: unknown[] }
const port = parentPort;
if (!port) throw new Error('SQLite storage worker requires a parent channel.');
let database: SqliteDatabase | undefined;
let initialized = false;

// Synchronous SQLite operations execute serially on this worker, never on the application's event loop.
port.on('message', (request: Request) => {
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
});
