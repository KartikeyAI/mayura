import { key } from './keys.js';

/**
 * Where every row lives. A partition holds what one access path reads together; sort keys start with a letter
 * component so that `key('x')` selects one kind of document within a partition. Rows the SQL layer finds through a
 * secondary index here have their own small index documents, written in the same transaction as the row.
 */
export const at = {
  /** A record: `r` the record, `e`+sequence its events, `o` its scheduled-workflow owner, `l`+job its node-to-job links,
   *  `w` its wait edges, `c` its published completion, `v`+run the runs waiting on it. */
  run: (scope: string, id: string) => key('run', scope, id),
  /** A record's idempotency key: `k` holds the record id. */
  idempotency: (scope: string, idempotencyKey: string) => key('idem', scope, idempotencyKey),
  /** Named locks: `l`. */
  lock: (...parts: string[]) => key('lock', ...parts),
  /** A job's run: `j` holds `{ run_id }`, which never changes. */
  job: (scope: string, jobId: string) => key('job', scope, jobId),
  /** A run's scheduler jobs: `j`+job the row, `q`+job its requested resources, `h`+job the resources it holds, `g` the guard. */
  runJobs: (scope: string, runId: string) => key('runjobs', scope, runId),
  reservation: (scope: string, reservationKey: string) => key('jobres', scope, reservationKey),
  invocation: (scope: string, invocationId: string) => key('jobinv', scope, invocationId),
  /** Ready jobs in due order: `q`+due+job. */
  ready: (scope: string) => key('ready', scope),
  /** Live (ready, leased or started) jobs in id order: `l`+job. */
  live: (scope: string) => key('live', scope),
  /** The jobs that requested a resource: `j`+job. */
  requesters: (scope: string, resourceKey: string) => key('resreq', scope, resourceKey),
  /** A held or quarantined resource: `h`. */
  resource: (scope: string, resourceKey: string) => key('res', scope, resourceKey),
  /** A run's scheduler journal: `h` the head, `e`+sequence the events. */
  schedulerEvents: (scope: string, runId: string) => key('schedev', scope, runId),
  /** Scheduled-workflow owners by scope, policy and profile, in id order: `r`+run. */
  discovery: (scope: string, policyHash: string, profile: number) => key('disc', scope, policyHash, profile),
} as const;
export const sort = {
  record: key('r'), owner: key('o'), waits: key('w'), completion: key('c'), guard: key('g'), head: key('h'), only: key('k'), lock: key('l'), jobRun: key('j'),
  event: (sequence: number) => key('e', sequence), link: (jobId: string) => key('l', jobId), waiter: (runId: string) => key('v', runId),
  job: (jobId: string) => key('j', jobId), requests: (jobId: string) => key('q', jobId), holds: (jobId: string) => key('h', jobId),
  ready: (dueAt: number, jobId: string) => key('q', dueAt, jobId), live: (jobId: string) => key('l', jobId), requester: (jobId: string) => key('j', jobId),
  discovered: (id: string) => key('r', id),
} as const;
export const kind = { event: key('e'), link: key('l'), waiter: key('v'), job: key('j'), holds: key('h'), ready: key('q'), live: key('l'), requester: key('j'), discovered: key('r') } as const;

export const json = <T>(text: string | undefined): T | undefined => text === undefined ? undefined : JSON.parse(text) as T;
