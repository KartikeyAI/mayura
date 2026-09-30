// MongoDB for the crash-test subprocesses: the public store, or the public store on a client whose transactions call
// `beforeCommit()` before committing, so a fixture can stop a process with a transaction written but not committed.
// Test-only: the store itself has no failpoint. The mongodb driver is the extension's own dependency.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMongoStore } from '@mayurajs/storage-mongodb';

const { MongoClient } = await import(pathToFileURL(createRequire(fileURLToPath(import.meta.resolve('@mayurajs/storage-mongodb'))).resolve('mongodb')).href);

/** Only disposable test databases on a loopback server. */
export function mongoOptions(options) {
  const { uri, database } = options ?? {};
  if (typeof uri !== 'string' || !/^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(uri) || typeof database !== 'string' || !/^mayura_test_[a-f0-9]{32}$/.test(database)) {
    throw new Error('Unexpected MongoDB fixture.');
  }
  return { uri, database };
}

export const mongoStore = options => createMongoStore(mongoOptions(options));

export function mongoStoreBeforeCommit(options, beforeCommit) {
  const { uri, database } = mongoOptions(options);
  const client = new MongoClient(uri);
  const startSession = client.startSession.bind(client);
  client.startSession = (...args) => {
    const session = startSession(...args);
    const commit = session.commitTransaction.bind(session);
    session.commitTransaction = async (...commitArgs) => { await beforeCommit(); return commit(...commitArgs); };
    return session;
  };
  return createMongoStore({ client, database });
}
