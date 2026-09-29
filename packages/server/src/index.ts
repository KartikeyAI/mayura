import { freezeJson, jsonValue, MayuraError, MEDIA_TYPES, mediaFromBase64, mediaUrl, type JsonObject, type JsonValue, type Media, type MediaType, type Outcome, type Permissions, type RunEvent, type RunHandle, type Scope } from '@mayura/core';
import { admitMedia } from '@mayura/core/host';
import { inspectorAsset } from './inspector.js';
import { assertAgent, createRuntime, type AgentDefinition, type Runtime, type RuntimeLimits } from '@mayura/runtime';

export interface ServerIdentity {
  readonly scope: Scope;
  readonly agentIds: readonly string[];
  readonly capabilities: readonly ('runs:read' | 'runs:submit' | 'runs:cancel' | 'operations:read' | 'humans:read' | 'humans:respond' | 'workflows:read' | 'workflows:control' | 'workflows:fleet' | 'workflows:migrate')[];
  readonly expiresAtMs: number;
}
export interface HealthCheck {
  readonly id: string;
  /** Trusted application callback. Returning false or throwing marks the dependency unavailable. */
  readonly check: (context: { readonly signal: AbortSignal; readonly scope: Scope }) => boolean | Promise<boolean>;
}
export interface HumanRequestRecord {
  readonly id: string; readonly agentId: string; readonly kind: 'information' | 'correction' | 'plan_selection';
  readonly schemaId: string; readonly schemaDigest: string; readonly prompt: string; readonly digest: string;
  readonly status: 'waiting' | 'answered' | 'cancelled' | 'timed_out'; readonly context?: JsonValue;
  readonly subjectDigest?: string; readonly deadlineAtMs?: number;
}
export interface HumanRequestTransport {
  readonly list: (input: { readonly scope: Scope; readonly agentIds: readonly string[]; readonly after: string | null; readonly limit: number; readonly signal: AbortSignal }) => Promise<{ readonly items: readonly HumanRequestRecord[]; readonly next: string | null }>;
  readonly inspect: (input: { readonly scope: Scope; readonly agentIds: readonly string[]; readonly id: string; readonly signal: AbortSignal }) => Promise<HumanRequestRecord | null>;
  readonly respond: (input: { readonly scope: Scope; readonly agentIds: readonly string[]; readonly actorId: string; readonly id: string;
    readonly requestDigest: string; readonly commandId: string; readonly value: JsonValue; readonly signal: AbortSignal }) => Promise<HumanRequestRecord>;
}
export interface WorkflowViewRecord {
  readonly format: 2 | 3 | 4 | 5; readonly definitionId: string; readonly definitionVersion: string; readonly runId: string;
  readonly revision: number; readonly status: 'running' | 'waiting' | 'paused' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
  readonly nodes: readonly { readonly id: string; readonly kind: 'tool' | 'join' | 'wait' | 'child' | 'human' | 'timer' | 'signal'; readonly dependsOn: readonly string[] }[];
  readonly steps: readonly { readonly id: string; readonly kind: 'tool' | 'join' | 'wait' | 'child' | 'human' | 'timer' | 'signal';
    readonly status: 'pending' | 'waiting' | 'approved' | 'dispatching' | 'succeeded' | 'failed' | 'blocked' | 'unknown' | 'skipped' | 'timed_out';
    readonly childRunId?: string; readonly approval?: WorkflowApprovalRecord }[];
}
/** A tool step waiting for approval: the digest an approval must name, its expiry and, when known, the exact tool call. */
export interface WorkflowApprovalRecord {
  readonly digest: string; readonly expiresAtMs: number;
  readonly subject?: { readonly toolId: string; readonly toolVersion: string; readonly input: JsonValue };
}
export interface WorkflowViewTransport {
  readonly inspect: (input: { readonly scope: Scope; readonly agentIds: readonly string[]; readonly runId: string;
    readonly signal: AbortSignal }) => Promise<WorkflowViewRecord | null>;
}
export interface WorkflowIndexRecord {
  readonly format: 2 | 3 | 4 | 5; readonly definitionId: string; readonly definitionVersion: string; readonly runId: string;
  readonly revision: number; readonly status: WorkflowViewRecord['status'];
  /** Only in the settled view: when the run reached its final status. */
  readonly settledAtMs?: number;
}
export interface WorkflowIndexTransport {
  /**
   * Active runs, or with `view: 'settled'` recently finished runs and runs whose outcome is unknown. The field is
   * present only for the settled view; a transport that ignores it fails the settled request closed.
   */
  readonly list: (input: { readonly scope: Scope; readonly agentIds: readonly string[]; readonly after: string | null;
    readonly limit: number; readonly signal: AbortSignal; readonly view?: 'settled' }) => Promise<{ readonly items: readonly WorkflowIndexRecord[]; readonly next: string | null }>;
}
export type WorkflowControlResult = { readonly status: 'applied'; readonly workflow: WorkflowViewRecord }
  | { readonly status: 'conflict' } | { readonly status: 'not_found' };
interface WorkflowControlBase {
  readonly scope: Scope; readonly agentIds: readonly string[]; readonly actorId: string; readonly runId: string;
  readonly revision: number; readonly commandId: string; readonly signal: AbortSignal;
}
export interface WorkflowControlTransport {
  readonly cancel: (input: WorkflowControlBase) => Promise<WorkflowControlResult>;
  readonly approve: (input: WorkflowControlBase & { readonly nodeId: string; readonly approvalDigest: string;
    readonly childRunId: string | null }) => Promise<WorkflowControlResult>;
}
/** Durable signal delivery remains an explicit adapter boundary so each workflow format owns persistence and idempotency. */
export interface WorkflowSignalTransport {
  readonly deliver: (input: WorkflowControlBase & { readonly signalId: string; readonly signalName: string;
    readonly value: JsonValue }) => Promise<WorkflowControlResult>;
}
/** Requests durable continuation without granting authority to force a waiting gate or replay an uncertain effect. */
export interface WorkflowResumeTransport {
  readonly resume: (input: WorkflowControlBase) => Promise<WorkflowControlResult>;
}
/** Requests a quiescent durable operator pause; it never interrupts an in-flight effect or cancels a run. */
export interface WorkflowPauseTransport {
  readonly pause: (input: WorkflowControlBase) => Promise<WorkflowControlResult>;
}
export interface WorkflowFleetHoldRecord { readonly held: boolean; readonly generation: number; readonly changedAtMs: number | null }
export type WorkflowFleetSweepOutcomeRecord =
  | { readonly target: string; readonly runId: string;
      readonly outcome: 'paused' | 'already_paused' | 'terminal' | 'busy' | 'resumed' | 'not_paused' | 'missing' | 'unregistered' }
  | { readonly target: string; readonly runId: string; readonly outcome: 'failed'; readonly code: string };
export interface WorkflowFleetSweepRecord { readonly outcomes: readonly WorkflowFleetSweepOutcomeRecord[]; readonly nextCursor: JsonObject | null }
interface WorkflowFleetBase { readonly scope: Scope; readonly agentIds: readonly string[]; readonly actorId: string; readonly signal: AbortSignal }
/** Durable fleet hold and ledger-backed sweep for one verified scope. Mutations require the separate `workflows:fleet` capability. */
export interface WorkflowFleetTransport {
  readonly inspect: (input: WorkflowFleetBase) => Promise<WorkflowFleetHoldRecord>;
  readonly hold: (input: WorkflowFleetBase) => Promise<WorkflowFleetHoldRecord>;
  readonly release: (input: WorkflowFleetBase) => Promise<WorkflowFleetHoldRecord>;
  readonly sweep: (input: WorkflowFleetBase & { readonly phase: 'pause' | 'resume'; readonly cursor: JsonObject | null; readonly limit: number })
    => Promise<{ readonly status: 'applied'; readonly sweep: WorkflowFleetSweepRecord } | { readonly status: 'conflict' }>;
}
/** A reviewed migration the host offers for runs pinned to its source definition. */
export interface WorkflowMigrationRecord {
  readonly id: string; readonly description: string;
  readonly fromVersion: string; readonly toVersion: string; readonly fromDigest: string; readonly toDigest: string;
}
/** What a migration would do to one run, decided from the run's real state. */
export interface WorkflowMigrationPlanRecord {
  readonly migrationId: string; readonly format: string; readonly runId: string; readonly fromDigest: string; readonly toDigest: string;
  readonly entries: readonly { readonly action: 'keep' | 'update' | 'reset' | 'accept' | 'add' | 'remove'; readonly target?: string; readonly source?: string; readonly status?: string }[];
  readonly blockers: readonly { readonly node: string; readonly reason: string }[];
  readonly allowed: boolean;
}
interface WorkflowMigrationBase { readonly scope: Scope; readonly agentIds: readonly string[]; readonly runId: string; readonly signal: AbortSignal }
/**
 * In-place migration of paused runs to a new definition version. Listing and planning are reads; applying requires the
 * separate `workflows:migrate` capability, the run's exact revision and a stable command id.
 */
export interface WorkflowMigrationTransport {
  /** Migrations whose source is the run's pinned definition; null when the run is not visible to this identity. */
  readonly list: (input: WorkflowMigrationBase) => Promise<readonly WorkflowMigrationRecord[] | null>;
  /** Dry run: the plan for this run. Writes nothing. Null when the run or migration is not visible. */
  readonly plan: (input: WorkflowMigrationBase & { readonly migrationId: string }) => Promise<WorkflowMigrationPlanRecord | null>;
  readonly apply: (input: WorkflowControlBase & { readonly migrationId: string }) => Promise<
    | { readonly status: 'applied'; readonly plan: WorkflowMigrationPlanRecord; readonly workflow: WorkflowViewRecord }
    | { readonly status: 'refused'; readonly plan: WorkflowMigrationPlanRecord }
    | { readonly status: 'conflict' } | { readonly status: 'not_found' }>;
}
export interface SubmissionJournal {
  readonly claim: (input: { readonly owner: string; readonly key: string; readonly digest: string; readonly signal: AbortSignal })
    => Promise<{ readonly status: 'claimed' } | { readonly status: 'existing'; readonly digest: string }>;
}
export type RunRecordStatus = 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
/** One durable agent run as every replica sees it. `snapshot` is the run's inspection; `outcome` is present once it ended. */
export interface RunRecordView {
  readonly runId: string; readonly agentId: string; readonly replicaId: string; readonly status: RunRecordStatus;
  readonly leaseExpiresAtMs: number; readonly cancelRequested: boolean; readonly lastSequence: number;
  readonly snapshot: JsonObject; readonly outcome?: JsonObject;
}
export type RunRecordClaim = { readonly status: 'claimed' }
  | { readonly status: 'existing'; readonly digest: string; readonly runId: string | null; readonly claimedAtMs: number };
/**
 * Durable agent run records shared by every server replica (`createAggregateRunRecords` in mayura/storage-contracts).
 * The replica that accepts a run executes it and is its only writer: it records metadata events, snapshots and the
 * outcome, and renews a lease. Any replica can read a run, stream its recorded events and request its cancellation,
 * which the owner observes. A run whose owner stops renewing its lease is settled as `outcome_unknown` by the next reader.
 */
export interface RunRecordStore {
  /** Atomically claim a submission key; an existing claim reports its digest and, once started, its run. */
  claim(input: { readonly owner: string; readonly key: string; readonly digest: string; readonly replicaId: string; readonly nowMs: number;
    readonly signal: AbortSignal }): Promise<RunRecordClaim>;
  /** Give up a claim whose run never started, so the same key can be submitted again. */
  release(input: { readonly owner: string; readonly key: string; readonly replicaId: string; readonly signal: AbortSignal }): Promise<void>;
  /** Create the run's record and bind the submission key to it. */
  start(input: { readonly owner: string; readonly key: string; readonly runId: string; readonly agentId: string; readonly replicaId: string;
    readonly leaseExpiresAtMs: number; readonly snapshot: JsonObject; readonly signal: AbortSignal }): Promise<void>;
  /** Owner only: append events in order, replace the snapshot, renew the lease and, last, record the outcome. */
  update(input: { readonly owner: string; readonly runId: string; readonly replicaId: string; readonly events: readonly RunEvent[];
    readonly snapshot: JsonObject; readonly leaseExpiresAtMs: number; readonly outcome?: JsonObject; readonly signal: AbortSignal })
    : Promise<{ readonly status: 'written'; readonly cancelRequested: boolean } | { readonly status: 'lost' }>;
  read(input: { readonly owner: string; readonly runId: string; readonly signal: AbortSignal }): Promise<RunRecordView | null>;
  /** Recorded events after a run sequence, in order; a missing range is one `events.gap`. */
  events(input: { readonly owner: string; readonly runId: string; readonly after: number; readonly limit: number; readonly signal: AbortSignal }): Promise<readonly RunEvent[]>;
  requestCancel(input: { readonly owner: string; readonly runId: string; readonly signal: AbortSignal }): Promise<RunRecordView | null>;
  /** Settle a running record whose lease expired before `nowMs` as `outcome_unknown`; returns the current record. */
  abandon(input: { readonly owner: string; readonly runId: string; readonly nowMs: number; readonly signal: AbortSignal }): Promise<RunRecordView | null>;
}
export interface RegisteredAgent {
  readonly agent: AgentDefinition;
  readonly permissions: Permissions;
  readonly limits?: RuntimeLimits;
}
export interface AgentServerOptions {
  readonly publicOrigin: string;
  /**
   * Browser origins other than `publicOrigin` allowed to call the API. A page served from `publicOrigin` itself is
   * always allowed.
   */
  readonly allowedOrigins?: readonly string[];
  /**
   * Set when a trusted reverse proxy or your own HTTP framework routes requests to this handler under another host or
   * scheme (for example `http://app:3000` inside a cluster). The request URL's scheme, host and port are then ignored
   * and `publicOrigin` is authoritative; only its path and query are used. Host and X-Forwarded-* headers are never
   * read. Without it, a request whose URL origin differs from `publicOrigin` is refused with INVALID_DESTINATION.
   */
  readonly mounted?: boolean;
  readonly agents: readonly RegisteredAgent[];
  /** Expose only a content-free process liveness response at GET /healthz. */
  readonly publicLiveness?: boolean;
  /** Serve the read-only local inspector at GET /inspector. Its static assets contain no data; every read is authenticated. */
  readonly inspector?: boolean;
  /** Access-controlled readiness checks. Credentials and exception details must remain inside callbacks. */
  readonly healthChecks?: readonly HealthCheck[];
  readonly humanRequests?: HumanRequestTransport;
  readonly workflowViews?: WorkflowViewTransport;
  readonly workflowIndex?: WorkflowIndexTransport;
  readonly workflowControls?: WorkflowControlTransport;
  readonly workflowSignals?: WorkflowSignalTransport;
  readonly workflowResumes?: WorkflowResumeTransport;
  readonly workflowPauses?: WorkflowPauseTransport;
  readonly workflowFleet?: WorkflowFleetTransport;
  readonly workflowMigrations?: WorkflowMigrationTransport;
  /**
   * Durable claim of every run submission key. Without it, idempotency lasts only as long as the process: a retry
   * after a restart could start a duplicate run. With it, such a retry is refused with SUBMISSION_OUTCOME_UNKNOWN.
   */
  readonly submissionJournal?: SubmissionJournal;
  /**
   * Resolve `{ artifact: reference }` media in a run submission: read the stored bytes for the caller's scope and
   * return them as media, for example `(reference, scope) => mediaFromArtifact(store, reference, scope)` with
   * `mediaFromArtifact` from mayura/artifacts. Without it, artifact media is refused with NOT_ENABLED.
   */
  readonly mediaArtifacts?: (reference: JsonObject, scope: Scope, signal: AbortSignal) => Promise<Media>;
  /**
   * Durable agent run records (`createAggregateRunRecords(store)` from mayura/storage-contracts). With them, several
   * replicas sharing one store can each read, stream, wait for and cancel any run, and a run whose replica dies ends as
   * `outcome_unknown` after its lease instead of disappearing. They also make submission idempotency durable.
   */
  readonly runRecords?: RunRecordStore;
  /**
   * Where an agent run executes. `'background'` (the default): the run keeps going in this process after
   * `POST /v1/runs` answers 202. `'request'`: the run finishes, and its outcome is recorded, before that 202 is sent, so
   * nothing runs once the response is out; use it where the platform may stop or freeze the process after it responds,
   * such as serverless functions. It requires `runRecords`, so any instance can serve the run's result and events
   * afterwards. The submission waits up to the agent's `limits.maxDurationMs` (60 s unless set) plus
   * `requestTimeoutMs`: keep that under the platform's time limit, and give clients a `requestTimeoutMs` above it.
   */
  readonly runExecution?: 'background' | 'request';
  /** Verify the token using trusted application authentication; never trust token claims without verification. */
  readonly authenticate: (request: { readonly token: string; readonly signal: AbortSignal }) => Promise<ServerIdentity | null>;
  readonly limits?: {
    readonly maxRuns?: number; readonly maxRuntimes?: number; readonly maxRequests?: number;
    readonly maxStreams?: number; readonly maxBodyBytes?: number; readonly maxResponseBytes?: number;
    /**
     * The body limit of a run submission when a registered agent accepts media (images and PDFs are sent as base64,
     * about a third larger than their bytes). Default 16 MiB; other requests keep maxBodyBytes.
     */
    readonly maxMediaBodyBytes?: number;
    readonly maxHealthOperations?: number; readonly maxHumanOperations?: number; readonly maxWorkflowOperations?: number;
    readonly requestTimeoutMs?: number; readonly streamDurationMs?: number;
    /**
     * How long a finished run stays readable (result, events and same-key resubmission) before the server releases
     * it, and with it any runtime no retained run still uses. Default 10 minutes. At `maxRuns` or `maxRuntimes` a
     * finished run whose outcome its owner has already read (a run read with its outcome, or an event stream read to
     * the end) is released early, oldest first; a result nobody has read is kept for the full period.
     * After release, a same-key resubmission is answered `410 RUN_EXPIRED` (or `409 IDEMPOTENCY_CONFLICT` for a
     * different payload) from a bounded tombstone rather than starting a second run. Configure `submissionJournal`
     * for idempotency that also survives restarts and tombstone expiry.
     */
    readonly runRetentionMs?: number;
    /** With `runRecords`: how long a run's owner lease lasts without renewal (default 30 s; renewed every third of it). */
    readonly runLeaseMs?: number;
    /** With `runRecords`: how often owners check for cancel requests and other replicas poll for new events (default 500 ms). */
    readonly runRecordPollMs?: number;
    /** How often an idle event stream sends a comment so proxies and clients see it is alive (default 15 s). */
    readonly streamHeartbeatMs?: number;
  };
}
export interface AgentServer { fetch(request: Request): Promise<Response>; close(): Promise<void> }
/** A submission another replica already started: answered with its run id. */
type Replay = { readonly replay: string; readonly digest: string };
interface Entry {
  readonly owner: string; readonly agentId: string; readonly digest: string;
  readonly handle: RunHandle<unknown>; readonly runtime: Runtime;
  readonly runtimeKey: string; readonly submissionKey: string;
  outcome?: Outcome<unknown>;
  finished?: boolean;
  /** With run records: settles once the owner has recorded the outcome (or lost the run, or the server closed). */
  persisted?: Promise<void>;
  /** The owner has received the outcome; the run may be released early under capacity pressure. */
  collected?: boolean;
  /** Another replica settled this durable run after its lease lapsed; its record, not this entry, is authoritative. */
  lost?: boolean;
}
/** Machine-useful, content-free facts an error may carry next to its code and message. */
type FailureDetails = { readonly retryAfterMs?: number; readonly capability?: string; readonly option?: string; readonly limitBytes?: number;
  readonly currentRevision?: number; readonly message?: string };
class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: ServerErrorCode, readonly details: FailureDetails = {}) { super(code); }
}
/**
 * Every error code the server answers with, and the fixed message that explains it. Messages never contain request
 * data, credentials or adapter text: only what happened and what to do. docs/guides/server-and-client.md lists them.
 */
const errorMessages = Object.freeze({
  AUTH_REQUIRED: 'Send an Authorization: Bearer <token> header with an access token.',
  AUTH_INVALID: 'The access token was not accepted. Get a new token and try again.',
  AUTH_EXPIRED: 'The identity for this access token has expired. Get a new token and try again.',
  AUTH_UNAVAILABLE: 'The server could not verify the access token right now. Retry shortly.',
  AUTH_LIMIT: 'Too many token verifications are in progress on this server. Retry after retryAfterMs.',
  IDENTITY_INVALID: 'The server\'s authenticate callback returned an identity Mayura cannot use: principalId, projectId and agent ids must be 1-128 letters, digits, ".", "_", "/" or "-" starting with a letter or digit, capabilities must be known, and expiresAtMs must be in the future. This is a server configuration problem.',
  CAPABILITY_REQUIRED: 'The access token lacks the capability this request needs (see capability).',
  ORIGIN_DENIED: 'Browser requests from this origin are not allowed. Add the page\'s exact origin to the server\'s allowedOrigins.',
  PREFLIGHT_DENIED: 'The CORS preflight asked for a method or header this API does not accept. Use GET or POST with only Authorization, Content-Type and Idempotency-Key.',
  INVALID_DESTINATION: 'The request URL\'s origin is not this server\'s publicOrigin. Send requests to the public origin, or set mounted: true when a trusted proxy or framework routes requests to this handler.',
  INVALID_QUERY: 'The query string has a parameter this route does not accept, or repeats one.',
  INVALID_CURSOR: 'The after or limit query parameter is invalid. Use a cursor the server returned and a limit from 1 to 100.',
  INVALID_JSON: 'The request body is not valid UTF-8 JSON.',
  INVALID_REQUEST: 'The request body does not have exactly the fields and types this route expects.',
  INVALID_MEDIA: 'The run\'s media was refused (see message): each item needs a supported mediaType and base64 data, an https url or an artifact reference, and the agent must accept it within its limits.',
  IDEMPOTENCY_KEY_REQUIRED: 'POST /v1/runs needs an Idempotency-Key header of 1-128 letters, digits, ".", "_", ":" or "-" starting with a letter or digit. Use one key per user action and reuse it only to retry that action.',
  UNSUPPORTED_MEDIA_TYPE: 'Send the request body as Content-Type: application/json, without Content-Encoding.',
  BODY_TOO_LARGE: 'The request body is larger than the server accepts (see limitBytes).',
  ROUTE_NOT_FOUND: 'This server has no such API route.',
  METHOD_NOT_ALLOWED: 'This API route does not accept this HTTP method.',
  NOT_ENABLED: 'This server does not offer this API: the operator has not configured it (see option).',
  AGENT_NOT_FOUND: 'No agent with this id is registered on this server and visible to this access token.',
  RUN_NOT_FOUND: 'No run with this id is visible to this access token. Finished runs are released after runRetentionMs, and without durable run records only the replica that started a run can read it.',
  HUMAN_REQUEST_NOT_FOUND: 'No human request with this id is visible to this access token.',
  WORKFLOW_RUN_NOT_FOUND: 'No workflow run with this id is visible to this access token.',
  MIGRATION_NOT_FOUND: 'No migration with this id is offered for this workflow run.',
  REQUEST_TIMEOUT: 'The request did not finish within the server\'s time limit, or the caller cancelled it. It may or may not have taken effect: retry with the same idempotency key or command id.',
  IDEMPOTENCY_CONFLICT: 'This Idempotency-Key was already used for a different agent or input. Use a new key for a new action.',
  SUBMISSION_IN_PROGRESS: 'Another server replica is still starting the run for this Idempotency-Key. Retry with the same key after retryAfterMs.',
  SUBMISSION_OUTCOME_UNKNOWN: 'This Idempotency-Key was claimed by a submission whose run can no longer be found, for example after a server restart. Mayura cannot tell whether it ran, so it will not start another. Check your own records before using a new key.',
  RUN_EXPIRED: 'The run for this Idempotency-Key finished and was released after runRetentionMs. Its result is no longer available; use a new key to run again.',
  WORKFLOW_CONFLICT: 'The workflow run changed since it was read, or is not in a state that accepts this command. Read the run again and decide with its current revision.',
  FLEET_CONFLICT: 'The fleet hold is not in the state this sweep needs: hold the fleet before a pause sweep and release it before a resume sweep.',
  MIGRATION_REFUSED: 'The migration has blockers for this run (see plan). Plan it again after resolving them.',
  REQUEST_LIMIT: 'The server is handling as many requests as it allows (maxRequests). Retry after retryAfterMs.',
  STREAM_LIMIT: 'The server has as many open event streams as it allows (maxStreams). Retry after retryAfterMs.',
  RUN_LIMIT: 'The server holds as many runs as it allows (maxRuns). Retry after retryAfterMs.',
  RUNTIME_LIMIT: 'The server holds as many runtimes as it allows (maxRuntimes). Retry after retryAfterMs.',
  HUMAN_LIMIT: 'Too many human request operations are in progress (maxHumanOperations). Retry after retryAfterMs.',
  WORKFLOW_LIMIT: 'Too many workflow operations are in progress (maxWorkflowOperations). Retry after retryAfterMs.',
  SERVER_CLOSED: 'The server is shutting down. Retry against another replica.',
  SERVICE_UNAVAILABLE: 'The server could not complete the request right now. Retry shortly.',
  SUBMISSION_JOURNAL_UNAVAILABLE: 'The submission could not be recorded in durable storage, so no run was started. Retry with the same Idempotency-Key.',
  RUN_RECORDS_UNAVAILABLE: 'Durable run records could not be read or written right now. Retry shortly; a submission refused with this code was cancelled before it could do work.',
  HUMAN_UNAVAILABLE: 'The human request service failed or is unavailable. Retry shortly.',
  HUMAN_TRANSPORT_INVALID: 'The server\'s human request adapter returned data Mayura could not validate. This is a server problem.',
  WORKFLOW_UNAVAILABLE: 'The workflow service failed or is unavailable. Retry shortly.',
  WORKFLOW_TRANSPORT_INVALID: 'The server\'s workflow adapter returned data Mayura could not validate. This is a server problem.',
  RESPONSE_TOO_LARGE: 'The response would be larger than the server allows (maxResponseBytes).',
  OBSERVATION_FAILED: 'The server could not follow this run\'s events from the requested position. Read the run, then reconnect from a sequence it has sent.',
  INTERNAL_ERROR: 'The server failed unexpectedly. The request may or may not have taken effect: retry with the same idempotency key or command id.',
} satisfies Record<string, string>);
export type ServerErrorCode = keyof typeof errorMessages;
/** Codes a client may retry after the hinted delay; the server sends retryAfterMs and a Retry-After header with them. */
const retryable: Readonly<Partial<Record<ServerErrorCode, number>>> = Object.freeze({
  AUTH_LIMIT: 1_000, REQUEST_LIMIT: 1_000, STREAM_LIMIT: 1_000, RUN_LIMIT: 1_000, RUNTIME_LIMIT: 1_000, HUMAN_LIMIT: 1_000, WORKFLOW_LIMIT: 1_000,
  SUBMISSION_IN_PROGRESS: 1_000, AUTH_UNAVAILABLE: 2_000, SERVER_CLOSED: 1_000, SERVICE_UNAVAILABLE: 2_000, SUBMISSION_JOURNAL_UNAVAILABLE: 2_000,
  RUN_RECORDS_UNAVAILABLE: 2_000, HUMAN_UNAVAILABLE: 2_000, WORKFLOW_UNAVAILABLE: 2_000,
});
const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const capabilities: readonly ServerIdentity['capabilities'][number][] = Object.freeze(['runs:read', 'runs:submit', 'runs:cancel', 'operations:read',
  'humans:read', 'humans:respond', 'workflows:read', 'workflows:control', 'workflows:fleet', 'workflows:migrate']);
const runStatuses = new Set(['running', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
/** Replica clocks may disagree by up to this much (or one lease, if shorter); a lease counts as lapsed only after it. */
const maxLeaseSkewMs = 5_000;
const commandFields = 'commandId must be 1-128 letters, digits, ".", "_", "/" or "-" starting with a letter or digit, and revision a positive integer.';
const humanIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const encoder = new TextEncoder();
const workflowKinds = Object.freeze({ 2: new Set(['tool', 'join']), 3: new Set(['tool', 'join', 'wait']),
  4: new Set(['tool', 'join', 'child']), 5: new Set(['tool', 'join', 'human', 'timer', 'signal']) });
const workflowStatuses = new Set(['running', 'waiting', 'paused', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const workflowStepStatuses = new Set(['pending', 'waiting', 'approved', 'dispatching', 'succeeded', 'failed', 'blocked', 'unknown', 'skipped', 'timed_out']);
const approvalRecord = (value: JsonValue | undefined): boolean => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value); const subject = value['subject'];
  return keys.every(key => ['digest', 'expiresAtMs', 'subject'].includes(key)) && typeof value['digest'] === 'string' && /^[a-f0-9]{64}$/.test(value['digest'])
    && typeof value['expiresAtMs'] === 'number' && Number.isSafeInteger(value['expiresAtMs']) && value['expiresAtMs'] > 0
    && (subject === undefined || (subject !== null && typeof subject === 'object' && !Array.isArray(subject)
      && Object.keys(subject).length === 3 && Object.hasOwn(subject, 'input')
      && typeof subject['toolId'] === 'string' && identifier.test(subject['toolId'])
      && typeof subject['toolVersion'] === 'string' && identifier.test(subject['toolVersion'])));
};
function object(value: unknown, maxBytes = 1_048_576): JsonObject {
  let copy: JsonValue;
  try { copy = jsonValue(value, { maxBytes }); } catch { throw new HttpFailure(400, 'INVALID_REQUEST'); }
  if (copy === null || Array.isArray(copy) || typeof copy !== 'object') throw new HttpFailure(400, 'INVALID_REQUEST');
  return copy;
}
/** Exact body fields. The message names the expected fields (API facts, never the request's own data). */
function exact(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) {
    throw new HttpFailure(400, 'INVALID_REQUEST', { message: keys.length === 0 ? 'Send an empty JSON object as the body.'
      : `Send a JSON object with exactly these fields: ${keys.join(', ')}.` });
  }
}
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  return Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}
function origin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid server origin.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Non-loopback origins require HTTPS.');
  return url.origin;
}
function assertActive(signal: AbortSignal): void { if (signal.aborted) throw new HttpFailure(408, 'REQUEST_TIMEOUT'); }
function workflowExact(value: JsonObject, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
}
function workflowRecord(value: unknown, expectedRunId: string): WorkflowViewRecord {
  let raw: JsonObject;
  try { raw = object(value, 262_144); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
  workflowExact(raw, ['format', 'definitionId', 'definitionVersion', 'runId', 'revision', 'status', 'nodes', 'steps']);
  const format = raw['format']; const nodes = raw['nodes']; const steps = raw['steps'];
  if (![2, 3, 4, 5].includes(format as number) || typeof raw['definitionId'] !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(raw['definitionId'])
    || typeof raw['definitionVersion'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(raw['definitionVersion'])
    || raw['runId'] !== expectedRunId || typeof raw['revision'] !== 'number' || !Number.isSafeInteger(raw['revision']) || raw['revision'] < 1
    || typeof raw['status'] !== 'string' || !workflowStatuses.has(raw['status']) || !Array.isArray(nodes) || nodes.length < 1 || nodes.length > 128
    || !Array.isArray(steps) || steps.length !== nodes.length) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  const admittedKinds = workflowKinds[format as keyof typeof workflowKinds]; const graph = new Map<string, readonly string[]>(); const nodeKinds = new Map<string, string>(); let edges = 0;
  for (const candidate of nodes) {
    let node: JsonObject; try { node = object(candidate, 32_768); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
    workflowExact(node, ['id', 'kind', 'dependsOn']);
    if (typeof node['id'] !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(node['id']) || graph.has(node['id'])
      || typeof node['kind'] !== 'string' || !admittedKinds.has(node['kind']) || !Array.isArray(node['dependsOn']) || node['dependsOn'].length > 127
      || node['dependsOn'].some(item => typeof item !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(item))
      || new Set(node['dependsOn']).size !== node['dependsOn'].length) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
    edges += node['dependsOn'].length; if (edges > 512) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
    graph.set(node['id'], node['dependsOn'] as readonly string[]); nodeKinds.set(node['id'], node['kind']);
  }
  for (const [id, dependencies] of graph) if (dependencies.some(dependency => dependency === id || !graph.has(dependency))) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  const seen = new Set<string>();
  for (const candidate of steps) {
    let step: JsonObject; try { step = object(candidate, 16_384); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
    const allowed = ['id', 'kind', 'status', 'childRunId', 'approval'];
    if (Object.keys(step).some(key => !allowed.includes(key)) || !['id', 'kind', 'status'].every(key => Object.hasOwn(step, key)) || typeof step['id'] !== 'string'
      || seen.has(step['id']) || step['kind'] !== nodeKinds.get(step['id']) || typeof step['status'] !== 'string' || !workflowStepStatuses.has(step['status'])
      || (step['kind'] === 'human' && !['pending', 'waiting', 'succeeded', 'timed_out', 'skipped'].includes(step['status']))
      || (step['kind'] === 'timer' && !['pending', 'waiting', 'succeeded', 'skipped'].includes(step['status']))
      || (step['kind'] === 'signal' && !['pending', 'waiting', 'succeeded', 'timed_out', 'skipped'].includes(step['status']))
      || (step['status'] === 'timed_out' && step['kind'] !== 'human' && step['kind'] !== 'signal')
      || (step['childRunId'] !== undefined && (step['kind'] !== 'child' || typeof step['childRunId'] !== 'string' || !/^[a-f0-9]{64}$/.test(step['childRunId'])))
      || (step['approval'] !== undefined && (step['kind'] !== 'tool' || step['status'] !== 'waiting' || !approvalRecord(step['approval'])))
      ) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
    seen.add(step['id']);
  }
  if (seen.size !== graph.size) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  const remaining = new Map([...graph].map(([id, dependencies]) => [id, dependencies.length])); const dependents = new Map<string, string[]>();
  for (const [id, dependencies] of graph) for (const dependency of dependencies) { const list = dependents.get(dependency) ?? []; list.push(id); dependents.set(dependency, list); }
  const queue = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
  for (let cursor = 0; cursor < queue.length; cursor++) for (const dependent of dependents.get(queue[cursor]!) ?? []) {
    const count = remaining.get(dependent)! - 1; remaining.set(dependent, count); if (count === 0) queue.push(dependent);
  }
  if (queue.length !== graph.size) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  return freezeJson(raw) as unknown as WorkflowViewRecord;
}
const fleetOutcomes = new Set(['paused', 'already_paused', 'terminal', 'busy', 'resumed', 'not_paused', 'missing', 'unregistered']);
function fleetHold(value: unknown): WorkflowFleetHoldRecord {
  let raw: JsonObject; try { raw = object(value, 1_024); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
  workflowExact(raw, ['held', 'generation', 'changedAtMs']);
  const { held, generation, changedAtMs } = raw;
  if (typeof held !== 'boolean' || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < (held ? 1 : 0)
    || (changedAtMs !== null && (typeof changedAtMs !== 'number' || !Number.isSafeInteger(changedAtMs) || changedAtMs < 0)))
    throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  return Object.freeze({ held, generation, changedAtMs: changedAtMs as number | null });
}
/** Sweep pages are content-free: target names, run identities and fixed outcome codes only. */
function fleetSweep(value: unknown, limit: number): WorkflowFleetSweepRecord {
  let raw: JsonObject; try { raw = object(value, 262_144); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
  workflowExact(raw, ['outcomes', 'nextCursor']);
  if (!Array.isArray(raw['outcomes']) || raw['outcomes'].length > limit) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  const outcomes = raw['outcomes'].map(entry => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
    const failed = entry['outcome'] === 'failed'; workflowExact(entry, failed ? ['target', 'runId', 'outcome', 'code'] : ['target', 'runId', 'outcome']);
    if (typeof entry['target'] !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(entry['target']) || typeof entry['runId'] !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry['runId']) || (failed ? typeof entry['code'] !== 'string' || !/^[A-Z][A-Z_]{0,39}$/.test(entry['code'])
        : !fleetOutcomes.has(String(entry['outcome'])))) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
    return Object.freeze({ ...entry }) as unknown as WorkflowFleetSweepOutcomeRecord;
  });
  let nextCursor: JsonObject | null = null;
  if (raw['nextCursor'] !== null) { try { nextCursor = object(raw['nextCursor'], 4_096); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); } }
  return Object.freeze({ outcomes: Object.freeze(outcomes), nextCursor });
}
const migrationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const migrationActions = new Set(['keep', 'update', 'reset', 'accept', 'add', 'remove']);
const nodeIdPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const shortText = (value: unknown, maximum: number): boolean => typeof value === 'string' && value.length <= maximum && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value);
function migrationRecord(value: unknown): WorkflowMigrationRecord {
  let raw: JsonObject; try { raw = object(value, 8_192); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
  workflowExact(raw, ['id', 'description', 'fromVersion', 'toVersion', 'fromDigest', 'toDigest']);
  if (typeof raw['id'] !== 'string' || !migrationIdPattern.test(raw['id']) || !shortText(raw['description'], 2_048)
    || typeof raw['fromVersion'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(raw['fromVersion'])
    || typeof raw['toVersion'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(raw['toVersion'])
    || typeof raw['fromDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['fromDigest'])
    || typeof raw['toDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['toDigest']) || raw['fromDigest'] === raw['toDigest']) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  return freezeJson(raw) as unknown as WorkflowMigrationRecord;
}
function migrationPlan(value: unknown, runId: string, migrationId: string): WorkflowMigrationPlanRecord {
  let raw: JsonObject; try { raw = object(value, 262_144); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
  workflowExact(raw, ['migrationId', 'format', 'runId', 'fromDigest', 'toDigest', 'entries', 'blockers', 'allowed']);
  const entries = raw['entries']; const blockers = raw['blockers'];
  if (raw['migrationId'] !== migrationId || raw['runId'] !== runId || typeof raw['format'] !== 'string' || !/^[a-z0-9-]{1,32}$/.test(raw['format'])
    || typeof raw['fromDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['fromDigest']) || typeof raw['toDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['toDigest'])
    || typeof raw['allowed'] !== 'boolean' || !Array.isArray(entries) || entries.length > 512 || !Array.isArray(blockers) || blockers.length > 512
    || raw['allowed'] !== (blockers.length === 0)) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
    if (Object.keys(entry).some(key => !['action', 'target', 'source', 'status'].includes(key)) || !migrationActions.has(String(entry['action']))
      || (entry['target'] !== undefined && (typeof entry['target'] !== 'string' || !nodeIdPattern.test(entry['target'])))
      || (entry['source'] !== undefined && (typeof entry['source'] !== 'string' || !nodeIdPattern.test(entry['source'])))
      || (entry['status'] !== undefined && (typeof entry['status'] !== 'string' || !/^[a-z_]{1,32}$/.test(entry['status'])))
      || (entry['target'] === undefined && entry['source'] === undefined)) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  }
  for (const blocker of blockers) {
    if (blocker === null || typeof blocker !== 'object' || Array.isArray(blocker)) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
    workflowExact(blocker, ['node', 'reason']);
    if (typeof blocker['node'] !== 'string' || !(blocker['node'] === '*' || nodeIdPattern.test(blocker['node'])) || !shortText(blocker['reason'], 512) || !blocker['reason'])
      throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  }
  return freezeJson(raw) as unknown as WorkflowMigrationPlanRecord;
}
const settledStatuses = new Set(['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
function workflowIndexRecord(value: unknown, settled = false): WorkflowIndexRecord {
  let raw: JsonObject; try { raw = object(value, 4_096); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
  workflowExact(raw, ['format', 'definitionId', 'definitionVersion', 'runId', 'revision', 'status', ...(settled ? ['settledAtMs'] : [])]);
  if (settled && (!settledStatuses.has(raw['status'] as string) || typeof raw['settledAtMs'] !== 'number' || !Number.isSafeInteger(raw['settledAtMs']) || raw['settledAtMs'] < 0))
    throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  if (![2, 3, 4, 5].includes(raw['format'] as number) || typeof raw['definitionId'] !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(raw['definitionId'])
    || typeof raw['definitionVersion'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(raw['definitionVersion'])
    || typeof raw['runId'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['runId']) || typeof raw['revision'] !== 'number'
    || !Number.isSafeInteger(raw['revision']) || raw['revision'] < 1 || typeof raw['status'] !== 'string' || !workflowStatuses.has(raw['status']))
    throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
  return freezeJson(raw) as unknown as WorkflowIndexRecord;
}
async function bounded<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void Promise.resolve(operation).catch(() => {}); throw new HttpFailure(408, 'REQUEST_TIMEOUT'); }
  assertActive(signal);
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(new HttpFailure(408, 'REQUEST_TIMEOUT')); };
    const cleanup = (): void => { signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(value => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error instanceof HttpFailure ? error : new HttpFailure(503, 'SERVICE_UNAVAILABLE')); });
    if (signal.aborted) abort();
  });
}

/** Authenticated Fetch facade. Hosting, TLS, durable execution, and token verification remain explicit. */
export function createAgentServer(options: AgentServerOptions): AgentServer {
  const publicOrigin = origin(options.publicOrigin);
  const origins = new Set((options.allowedOrigins ?? []).map(origin));
  if (typeof options.authenticate !== 'function' || !Array.isArray(options.agents) || options.agents.length > 256) throw new Error('Explicit authentication and a bounded agent registry are required.');
  const authenticate = options.authenticate;
  if (options.publicLiveness !== undefined && typeof options.publicLiveness !== 'boolean') throw new Error('Public liveness must be explicit.');
  if (options.inspector !== undefined && typeof options.inspector !== 'boolean') throw new Error('The inspector setting must be a boolean.');
  if (options.mounted !== undefined && typeof options.mounted !== 'boolean') throw new Error('The mounted setting must be a boolean.');
  const limits = Object.freeze({ maxRuns: 512, maxRuntimes: 128, maxRequests: 64, maxStreams: 64,
    maxBodyBytes: 1_048_576, maxMediaBodyBytes: 16_777_216, maxResponseBytes: 4_194_304, maxHealthOperations: 32, maxHumanOperations: 32, maxWorkflowOperations: 32,
    requestTimeoutMs: 10_000, streamDurationMs: 30_000, runRetentionMs: 600_000, runLeaseMs: 30_000, runRecordPollMs: 500, streamHeartbeatMs: 15_000, ...options.limits });
  if (Object.keys(limits).some(key => !['maxRuns', 'maxRuntimes', 'maxRequests', 'maxStreams', 'maxBodyBytes', 'maxMediaBodyBytes', 'maxResponseBytes', 'maxHealthOperations', 'maxHumanOperations', 'maxWorkflowOperations', 'requestTimeoutMs', 'streamDurationMs', 'runRetentionMs', 'runLeaseMs', 'runRecordPollMs', 'streamHeartbeatMs'].includes(key))) throw new Error('Unknown server limit.');
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > 16_777_216) throw new Error('Server limits must be bounded positive integers.');
  const healthChecks: readonly HealthCheck[] = (() => {
    const supplied = options.healthChecks ?? [];
    if (!Array.isArray(supplied) || supplied.length > 32) throw new Error('Health checks must be a bounded dense list.');
    const descriptors = Object.getOwnPropertyDescriptors(supplied);
    if (Reflect.ownKeys(descriptors).length !== supplied.length + 1) throw new Error('Health checks must be a bounded dense list.');
    const ids = new Set<string>(); const captured: HealthCheck[] = [];
    for (let index = 0; index < supplied.length; index++) {
      const entry = descriptors[String(index)];
      if (!entry || !('value' in entry) || entry.value === null || typeof entry.value !== 'object') throw new Error('Health checks must contain data entries.');
      const fields = Object.getOwnPropertyDescriptors(entry.value as object);
      if (Reflect.ownKeys(fields).some(key => !['id', 'check'].includes(String(key)))) throw new Error('Health checks contain unknown fields.');
      const id = fields['id']; const check = fields['check'];
      if (!id || !('value' in id) || typeof id.value !== 'string' || !identifier.test(id.value) || ids.has(id.value)
        || !check || !('value' in check) || typeof check.value !== 'function') throw new Error('Health checks require unique IDs and callbacks.');
      ids.add(id.value); captured.push(Object.freeze({ id: id.value, check: check.value as HealthCheck['check'] }));
    }
    return Object.freeze(captured);
  })();
  const humanRequests: HumanRequestTransport | undefined = (() => {
    if (options.humanRequests === undefined) return undefined;
    if (options.humanRequests === null || typeof options.humanRequests !== 'object') throw new Error('Human request transport is invalid.');
    const fields = Object.getOwnPropertyDescriptors(options.humanRequests);
    if (Reflect.ownKeys(fields).length !== 3 || ['list', 'inspect', 'respond'].some(key => !fields[key] || !('value' in fields[key]!) || typeof fields[key]!.value !== 'function')) throw new Error('Human request transport requires exact callbacks.');
    return Object.freeze({ list: fields['list']!.value, inspect: fields['inspect']!.value, respond: fields['respond']!.value }) as HumanRequestTransport;
  })();
  const workflowViews: WorkflowViewTransport | undefined = (() => {
    if (options.workflowViews === undefined) return undefined;
    if (options.workflowViews === null || typeof options.workflowViews !== 'object') throw new Error('Workflow view transport is invalid.');
    const fields = Object.getOwnPropertyDescriptors(options.workflowViews);
    if (Reflect.ownKeys(fields).length !== 1 || !fields['inspect'] || !('value' in fields['inspect']) || typeof fields['inspect'].value !== 'function')
      throw new Error('Workflow view transport requires one exact inspect callback.');
    return Object.freeze({ inspect: fields['inspect'].value as WorkflowViewTransport['inspect'] });
  })();
  const workflowIndex: WorkflowIndexTransport | undefined = (() => {
    if (options.workflowIndex === undefined) return undefined;
    if (options.workflowIndex === null || typeof options.workflowIndex !== 'object') throw new Error('Workflow index transport is invalid.');
    const fields = Object.getOwnPropertyDescriptors(options.workflowIndex);
    if (Reflect.ownKeys(fields).length !== 1 || !fields['list'] || !('value' in fields['list']) || typeof fields['list'].value !== 'function')
      throw new Error('Workflow index transport requires one exact list callback.');
    return Object.freeze({ list: fields['list'].value as WorkflowIndexTransport['list'] });
  })();
  const workflowControls: WorkflowControlTransport | undefined = (() => {
    if (options.workflowControls === undefined) return undefined;
    if (options.workflowControls === null || typeof options.workflowControls !== 'object') throw new Error('Workflow control transport is invalid.');
    const fields = Object.getOwnPropertyDescriptors(options.workflowControls);
    if (Reflect.ownKeys(fields).length !== 2 || ['cancel', 'approve'].some(key => !fields[key] || !('value' in fields[key]!) || typeof fields[key]!.value !== 'function'))
      throw new Error('Workflow control transport requires exact cancel and approve callbacks.');
    return Object.freeze({ cancel: fields['cancel']!.value, approve: fields['approve']!.value }) as WorkflowControlTransport;
  })();
  const workflowSignals: WorkflowSignalTransport | undefined = (() => {
    if (options.workflowSignals === undefined) return undefined;
    if (options.workflowSignals === null || typeof options.workflowSignals !== 'object') throw new Error('Workflow signal transport is invalid.');
    const fields = Object.getOwnPropertyDescriptors(options.workflowSignals);
    if (Reflect.ownKeys(fields).length !== 1 || !fields['deliver'] || !('value' in fields['deliver']) || typeof fields['deliver'].value !== 'function')
      throw new Error('Workflow signal transport requires one exact deliver callback.');
    return Object.freeze({ deliver: fields['deliver'].value as WorkflowSignalTransport['deliver'] });
  })();
  const workflowResumes: WorkflowResumeTransport | undefined = (() => {
    if (options.workflowResumes === undefined) return undefined;
    if (options.workflowResumes === null || typeof options.workflowResumes !== 'object') throw new Error('Workflow resume transport is invalid.');
    const fields = Object.getOwnPropertyDescriptors(options.workflowResumes);
    if (Reflect.ownKeys(fields).length !== 1 || !fields['resume'] || !('value' in fields['resume']) || typeof fields['resume'].value !== 'function')
      throw new Error('Workflow resume transport requires one exact resume callback.');
    return Object.freeze({ resume: fields['resume'].value as WorkflowResumeTransport['resume'] });
  })();
  const workflowPauses: WorkflowPauseTransport | undefined = (() => {
    if (options.workflowPauses === undefined) return undefined;
    if (options.workflowPauses === null || typeof options.workflowPauses !== 'object') throw new Error('Workflow pause transport is invalid.');
    const fields = Object.getOwnPropertyDescriptors(options.workflowPauses);
    if (Reflect.ownKeys(fields).length !== 1 || !fields['pause'] || !('value' in fields['pause']) || typeof fields['pause'].value !== 'function')
      throw new Error('Workflow pause transport requires one exact pause callback.');
    return Object.freeze({ pause: fields['pause'].value as WorkflowPauseTransport['pause'] });
  })();
  const workflowFleet: WorkflowFleetTransport | undefined = (() => {
    if (options.workflowFleet === undefined) return undefined;
    if (options.workflowFleet === null || typeof options.workflowFleet !== 'object') throw new Error('Workflow fleet transport is invalid.');
    const fields = Object.getOwnPropertyDescriptors(options.workflowFleet); const names = ['inspect', 'hold', 'release', 'sweep'] as const;
    if (Reflect.ownKeys(fields).length !== names.length || names.some(name => !fields[name] || !('value' in fields[name]!) || typeof fields[name]!.value !== 'function'))
      throw new Error('Workflow fleet transport requires exact inspect, hold, release and sweep callbacks.');
    return Object.freeze(Object.fromEntries(names.map(name => [name, fields[name]!.value])) as unknown as WorkflowFleetTransport);
  })();
  const workflowMigrations: WorkflowMigrationTransport | undefined = (() => {
    if (options.workflowMigrations === undefined) return undefined;
    if (options.workflowMigrations === null || typeof options.workflowMigrations !== 'object') throw new Error('Workflow migration transport is invalid.');
    const fields = Object.getOwnPropertyDescriptors(options.workflowMigrations); const names = ['list', 'plan', 'apply'] as const;
    if (Reflect.ownKeys(fields).length !== names.length || names.some(name => !fields[name] || !('value' in fields[name]!) || typeof fields[name]!.value !== 'function'))
      throw new Error('Workflow migration transport requires exact list, plan and apply callbacks.');
    return Object.freeze(Object.fromEntries(names.map(name => [name, fields[name]!.value])) as unknown as WorkflowMigrationTransport);
  })();
  const registry = new Map<string, RegisteredAgent>();
  for (const config of options.agents) {
    assertAgent(config.agent);
    if (registry.has(config.agent.id)) throw new Error('Agent registry IDs must be unique.');
    // Validate configuration now, not after accepting an HTTP command. No model work is performed.
    const permissions = Object.freeze({ allow: Object.freeze([...config.permissions.allow]) });
    const settings = config.limits === undefined ? {} : Object.freeze({ ...config.limits });
    const check = createRuntime({ profile: 'ephemeral', permissions, limits: settings });
    void check.close();
    registry.set(config.agent.id, Object.freeze({ agent: config.agent, permissions, limits: settings }));
  }
  // Run submissions may carry media only when some agent accepts it; otherwise they keep the ordinary body limit.
  const runBodyBytes = [...registry.values()].some(config => config.agent.media) ? Math.max(limits.maxBodyBytes, limits.maxMediaBodyBytes) : limits.maxBodyBytes;
  const mediaArtifacts = options.mediaArtifacts;
  if (mediaArtifacts !== undefined && typeof mediaArtifacts !== 'function') throw new Error('mediaArtifacts must be a function.');
  /** Media items of a run submission, as Mayura media: base64 bytes, an https URL, or a stored artifact. */
  const submittedMedia = async (value: JsonValue | undefined, scope: Scope, signal: AbortSignal): Promise<readonly Media[]> => {
    if (value === undefined) return [];
    const refuse = (message: string): never => { throw new HttpFailure(400, 'INVALID_MEDIA', { message }); };
    if (!Array.isArray(value) || value.length > 32) return refuse('media must be a list of at most 32 items.');
    const items: Media[] = [];
    for (const [index, raw] of value.entries()) {
      const label = `media ${index + 1}`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse(`${label} must be an object.`);
      const keys = Object.keys(raw).sort().join(',');
      const name = raw['name']; const mediaType = raw['mediaType'];
      if (name !== undefined && typeof name !== 'string') refuse(`${label}: name must be text.`);
      const options = name === undefined ? {} : { name: name as string };
      try {
        if (keys === 'artifact' || keys === 'artifact,name') {
          if (!mediaArtifacts) throw new HttpFailure(404, 'NOT_ENABLED', { option: 'mediaArtifacts' });
          const reference = raw['artifact'];
          if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return refuse(`${label}: artifact must be an artifact reference.`);
          let item: Media;
          try { item = await bounded(Promise.resolve().then(() => mediaArtifacts(reference, scope, signal)), signal); }
          catch (error) { if (error instanceof HttpFailure && error.status === 408) throw error; return refuse(`${label}: the artifact could not be read for this caller.`); }
          items.push(item);
          continue;
        }
        if (typeof mediaType !== 'string' || !(MEDIA_TYPES as readonly string[]).includes(mediaType)) return refuse(`${label}: mediaType must be one of ${MEDIA_TYPES.join(', ')}.`);
        if (keys === 'data,mediaType' || keys === 'data,mediaType,name') {
          if (typeof raw['data'] !== 'string') return refuse(`${label}: data must be base64 text.`);
          items.push(mediaFromBase64(raw['data'], mediaType as MediaType, options));
        } else if (keys === 'mediaType,url' || keys === 'mediaType,name,url') {
          if (typeof raw['url'] !== 'string') return refuse(`${label}: url must be text.`);
          items.push(mediaUrl(raw['url'], mediaType as MediaType, options));
        } else return refuse(`${label} must have mediaType with data (base64) or url, or an artifact reference, and optionally a name.`);
      } catch (error) {
        if (error instanceof MayuraError) return refuse(`${label}: ${error.message}`);
        throw error;
      }
    }
    return items;
  };
  /** A digest of each media item for the idempotency key: its bytes' SHA-256, or its URL. */
  const mediaDigests = async (items: readonly Media[]): Promise<JsonValue> => Promise.all(items.map(async item => {
    if (!('data' in item)) return { mediaType: item.mediaType, url: item.url, name: item.name ?? null };
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(item.data)));
    return { mediaType: item.mediaType, sha256: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''), name: item.name ?? null };
  }));
  const toolCatalog = Object.freeze([...registry.values()].flatMap(config => config.agent.tools.map(tool => Object.freeze({
    agentId: config.agent.id, agentVersion: config.agent.version, id: tool.id, version: tool.version,
    effects: tool.effects, capabilities: tool.capabilities, timeoutMs: tool.timeoutMs, costMicros: tool.costMicros,
  }))).sort((left, right) => left.agentId.localeCompare(right.agentId) || left.id.localeCompare(right.id) || left.version.localeCompare(right.version)));
  const runtimes = new Map<string, Runtime>();
  const runs = new Map<string, Entry>();
  // Same-process concurrent submissions share one journal claim and one run.
  const pendingSubmissions = new Map<string, Promise<Entry | 'duplicate' | Replay>>();
  const submissionJournal = (() => {
    if (options.submissionJournal === undefined) return undefined;
    if (options.submissionJournal === null || typeof options.submissionJournal !== 'object' || typeof options.submissionJournal.claim !== 'function')
      throw new Error('Submission journal requires a claim function.');
    return Object.freeze({ claim: options.submissionJournal.claim.bind(options.submissionJournal) });
  })();
  const runRecords: RunRecordStore | undefined = (() => {
    if (options.runRecords === undefined) return undefined;
    const names = ['claim', 'release', 'start', 'update', 'read', 'events', 'requestCancel', 'abandon'] as const;
    const supplied = options.runRecords as unknown as Record<string, unknown> | null;
    if (supplied === null || typeof supplied !== 'object' || names.some(name => typeof supplied[name] !== 'function'))
      throw new Error('Run records require claim, release, start, update, read, events, requestCancel and abandon functions.');
    return Object.freeze(Object.fromEntries(names.map(name => [name, (supplied[name] as (...values: unknown[]) => unknown).bind(supplied)])) as unknown as RunRecordStore);
  })();
  const runExecution = options.runExecution ?? 'background';
  if (runExecution !== 'background' && runExecution !== 'request') throw new MayuraError('INVALID_CONFIG', "runExecution must be 'background' or 'request'.");
  if (runExecution === 'request' && !runRecords) throw new MayuraError('INVALID_CONFIG', "runExecution 'request' requires runRecords, so any instance can serve a run's result and events.");
  // In request mode a submission lasts as long as the longest run it may start, plus time to record the outcome.
  const submissionTimeoutMs = runExecution === 'request'
    ? Math.max(...[...registry.values()].map(agent => agent.limits?.maxDurationMs ?? 60_000)) + limits.requestTimeoutMs : limits.requestTimeoutMs;
  // Identifies this server instance as the owner of the runs it executes; never derived from request data.
  const replicaId = crypto.randomUUID(); const leaseSkewMs = Math.min(maxLeaseSkewMs, limits.runLeaseMs);
  const submissions = new Map<string, Entry>();
  // Runs retained per runtime; a runtime closes when its last retained run is released.
  const retained = new Map<string, number>();
  const retentionTimers = new Set<ReturnType<typeof setTimeout>>();
  // Idempotency evidence for released runs: submission key -> request digest, oldest dropped past a fixed bound.
  const tombstones = new Map<string, string>(); const maxTombstones = 16_384;
  const release = (entry: Entry): void => {
    if (runs.get(entry.handle.id) !== entry) return;
    runs.delete(entry.handle.id);
    if (submissions.get(entry.submissionKey) === entry) {
      submissions.delete(entry.submissionKey); tombstones.delete(entry.submissionKey);
      // Durable run records answer a released key themselves; tombstones cover only in-memory runs.
      if (!runRecords) tombstones.set(entry.submissionKey, entry.digest);
      if (tombstones.size > maxTombstones) tombstones.delete(tombstones.keys().next().value!);
    }
    const remaining = (retained.get(entry.runtimeKey) ?? 1) - 1;
    if (remaining > 0) { retained.set(entry.runtimeKey, remaining); return; }
    retained.delete(entry.runtimeKey);
    const runtime = runtimes.get(entry.runtimeKey);
    if (runtime === entry.runtime) { runtimes.delete(entry.runtimeKey); void Promise.resolve().then(() => runtime.close()).catch(() => undefined); }
  };
  /** Release the oldest finished runs until a new run (and, when needed, a new runtime) fits. Active runs are never released. */
  const makeRoom = (runtimeKey: string): void => {
    for (const entry of runs.values()) {
      if (runs.size < limits.maxRuns && (runtimes.has(runtimeKey) || runtimes.size < limits.maxRuntimes)) return;
      if (entry.finished && entry.collected) release(entry);
    }
  };
  const streams = new Set<() => void>();
  let closed = false;
  let requests = 0;
  let authentications = 0;
  let healthOperations = 0;
  let humanOperations = 0;
  let workflowOperations = 0;

  const humanRecord = (value: unknown, identity: ServerIdentity): HumanRequestRecord => {
    let raw: JsonObject; try { raw = object(value, 16_384); } catch { throw new HttpFailure(503, 'HUMAN_TRANSPORT_INVALID'); }
    const allowed = ['id', 'agentId', 'kind', 'schemaId', 'schemaDigest', 'prompt', 'digest', 'status', 'context', 'subjectDigest', 'deadlineAtMs'];
    if (Object.keys(raw).some(key => !allowed.includes(key)) || !['id', 'agentId', 'kind', 'schemaId', 'schemaDigest', 'prompt', 'digest', 'status'].every(key => Object.hasOwn(raw, key))
      || typeof raw['id'] !== 'string' || !humanIdentifier.test(raw['id']) || typeof raw['agentId'] !== 'string' || !identity.agentIds.includes(raw['agentId'])
      || !['information', 'correction', 'plan_selection'].includes(String(raw['kind'])) || typeof raw['schemaId'] !== 'string' || !identifier.test(raw['schemaId'])
      || typeof raw['schemaDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['schemaDigest']) || typeof raw['digest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['digest'])
      || typeof raw['prompt'] !== 'string' || encoder.encode(raw['prompt']).byteLength < 1 || encoder.encode(raw['prompt']).byteLength > 1_024
      || !['waiting', 'answered', 'cancelled', 'timed_out'].includes(String(raw['status']))
      || (raw['subjectDigest'] !== undefined && (typeof raw['subjectDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(raw['subjectDigest'])))
      || ((raw['kind'] === 'correction') !== (raw['subjectDigest'] !== undefined))
      || (raw['deadlineAtMs'] !== undefined && (!Number.isSafeInteger(raw['deadlineAtMs']) || (raw['deadlineAtMs'] as number) < 0))) throw new HttpFailure(503, 'HUMAN_TRANSPORT_INVALID');
    return freezeJson(raw) as unknown as HumanRequestRecord;
  };
  const humanCall = async <T>(callback: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    if (humanOperations >= limits.maxHumanOperations) throw new HttpFailure(429, 'HUMAN_LIMIT');
    humanOperations++; const operation = Promise.resolve().then(callback).finally(() => { humanOperations--; });
    try { return await bounded(operation, signal); } catch (error) { if (error instanceof HttpFailure && error.status === 408) throw error; throw new HttpFailure(503, 'HUMAN_UNAVAILABLE'); }
  };

  const response = (value: unknown, status = 200, extra: Record<string, string> = {}): Response => {
    let text: string;
    try { text = JSON.stringify(jsonValue(value, { maxBytes: limits.maxResponseBytes })); }
    catch { text = JSON.stringify({ error: { code: 'RESPONSE_TOO_LARGE', message: errorMessages.RESPONSE_TOO_LARGE } }); status = 500; extra = {}; }
    return new Response(text, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
  };
  /** `{ error: { code, message, ...details } }`, plus `Retry-After` for codes worth retrying. */
  const failureResponse = (failure: HttpFailure, extraBody: Record<string, JsonValue> = {}): Response => {
    const { message, ...details } = failure.details; const retryAfterMs = details.retryAfterMs ?? retryable[failure.code];
    return response({ ...extraBody, error: { code: failure.code, message: message ?? errorMessages[failure.code], ...details,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } }, failure.status,
    retryAfterMs === undefined ? {} : { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1_000))) });
  };
  const session = async (request: Request, signal: AbortSignal): Promise<ServerIdentity> => {
    const authorization = request.headers.get('authorization') ?? '';
    if (!/^Bearer [\x21-\x7e]{1,8192}$/.test(authorization)) throw new HttpFailure(401, 'AUTH_REQUIRED');
    let supplied: ServerIdentity | null;
    assertActive(signal);
    if (authentications >= limits.maxRequests) throw new HttpFailure(429, 'AUTH_LIMIT');
    authentications++;
    const verification = Promise.resolve().then(() => {
      assertActive(signal); return authenticate(Object.freeze({ token: authorization.slice(7), signal }));
    }).finally(() => { authentications--; });
    // A non-cooperative verifier retains its admission until it really completes.
    try { supplied = await bounded(verification, signal); }
    catch { assertActive(signal); throw new HttpFailure(503, 'AUTH_UNAVAILABLE'); }
    assertActive(signal);
    // null is the verifier's "not accepted"; an identity Mayura cannot use is the application's configuration problem.
    if (supplied === null) throw new HttpFailure(401, 'AUTH_INVALID');
    let raw: JsonObject;
    try {
      raw = object(supplied, 65_536); const scope = object(raw['scope']);
      exact(raw, ['scope', 'agentIds', 'capabilities', 'expiresAtMs']); exact(scope, ['principalId', 'projectId']);
      if (typeof scope['principalId'] !== 'string' || !identifier.test(scope['principalId']) || typeof scope['projectId'] !== 'string' || !identifier.test(scope['projectId'])
        || !Array.isArray(raw['agentIds']) || raw['agentIds'].length > 256 || raw['agentIds'].some(id => typeof id !== 'string' || !identifier.test(id))
        || !Array.isArray(raw['capabilities']) || raw['capabilities'].length > 10 || raw['capabilities'].some(cap => !(capabilities as readonly string[]).includes(String(cap)))
        || typeof raw['expiresAtMs'] !== 'number' || !Number.isSafeInteger(raw['expiresAtMs'])) throw new Error();
    } catch { throw new HttpFailure(500, 'IDENTITY_INVALID'); }
    if ((raw['expiresAtMs'] as number) <= Date.now()) throw new HttpFailure(401, 'AUTH_EXPIRED');
    return freezeJson(raw) as unknown as ServerIdentity;
  };
  const requireCapability = (identity: ServerIdentity, capability: ServerIdentity['capabilities'][number]): void => {
    if (!identity.capabilities.includes(capability)) throw new HttpFailure(403, 'CAPABILITY_REQUIRED', { capability });
    if (identity.expiresAtMs <= Date.now()) throw new HttpFailure(401, 'AUTH_EXPIRED');
  };
  const body = async (request: Request, signal: AbortSignal, maxBodyBytes = limits.maxBodyBytes): Promise<JsonObject> => {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') || request.headers.has('content-encoding')) throw new HttpFailure(415, 'UNSUPPORTED_MEDIA_TYPE');
    const declared = request.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBodyBytes)) throw new HttpFailure(413, 'BODY_TOO_LARGE', { limitBytes: maxBodyBytes });
    const reader = request.body?.getReader();
    if (!reader) throw new HttpFailure(400, 'INVALID_JSON', { message: 'This request needs a JSON body.' });
    const chunks: Uint8Array[] = []; let total = 0; let complete = false;
    try {
      while (true) {
        const item = await bounded(reader.read(), signal);
        if (item.done) { complete = true; break; }
        total += item.value.byteLength;
        if (total > maxBodyBytes) throw new HttpFailure(413, 'BODY_TOO_LARGE', { limitBytes: maxBodyBytes });
        chunks.push(item.value);
      }
      const data = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); } catch { throw new HttpFailure(400, 'INVALID_JSON'); }
      try { return object(parsed, maxBodyBytes); }
      catch { throw new HttpFailure(400, 'INVALID_REQUEST', { message: 'The body must be a JSON object within the server\'s depth and size limits.' }); }
    } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  /** A run-record call bounded by the signal; any failure other than a timeout is RUN_RECORDS_UNAVAILABLE. */
  const recorded = async <T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    try { return await bounded(Promise.resolve().then(call), signal); }
    catch (error) { if (error instanceof HttpFailure && error.status === 408) throw error; throw new HttpFailure(503, 'RUN_RECORDS_UNAVAILABLE'); }
  };
  const recordView = (value: unknown, runId: string): RunRecordView | null => {
    if (value === null) return null;
    let raw: JsonObject; try { raw = object(value, 8_388_608); } catch { throw new HttpFailure(503, 'RUN_RECORDS_UNAVAILABLE'); }
    const snapshot = raw['snapshot']; const outcome = raw['outcome']; const status = raw['status'];
    if (Object.keys(raw).some(key => !['runId', 'agentId', 'replicaId', 'status', 'leaseExpiresAtMs', 'cancelRequested', 'lastSequence', 'snapshot', 'outcome'].includes(key))
      || raw['runId'] !== runId || typeof raw['agentId'] !== 'string' || !identifier.test(raw['agentId']) || typeof raw['replicaId'] !== 'string'
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw['replicaId']) || typeof status !== 'string' || !runStatuses.has(status)
      || !Number.isSafeInteger(raw['leaseExpiresAtMs']) || typeof raw['cancelRequested'] !== 'boolean' || !Number.isSafeInteger(raw['lastSequence']) || (raw['lastSequence'] as number) < 0
      || snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot) || Object.keys(snapshot).some(key => !['id', 'status', 'budget', 'evidence'].includes(key))
      || snapshot['id'] !== runId || snapshot['status'] !== status
      || (status === 'running') !== (outcome === undefined)
      || (outcome !== undefined && (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome) || outcome['status'] !== status))) throw new HttpFailure(503, 'RUN_RECORDS_UNAVAILABLE');
    return raw as unknown as RunRecordView;
  };
  /** Read a durable run; a running run whose owner's lease lapsed is settled as outcome_unknown first. */
  const readRecord = async (owner: string, runId: string, signal: AbortSignal): Promise<RunRecordView | null> => {
    const records = runRecords!;
    let record = recordView(await recorded(() => records.read({ owner, runId, signal }), signal), runId);
    if (record?.status === 'running' && record.replicaId !== replicaId && record.leaseExpiresAtMs < Date.now() - leaseSkewMs) {
      record = recordView(await recorded(() => records.abandon({ owner, runId, nowMs: Date.now() - leaseSkewMs, signal }), signal), runId);
    }
    return record;
  };

  /**
   * One bounded SSE response over a run's events. An idle stream sends a comment every `streamHeartbeatMs` so proxies
   * keep it open and clients can tell a quiet run from a dead connection. The stream ends when the run's events end,
   * after `streamDurationMs`, or when the identity expires; clients reconnect from their last sequence.
   */
  const eventStream = (open: (signal: AbortSignal) => AsyncIterator<RunEvent>, identity: ServerIdentity, request: Request, onDone?: () => void): Response => {
    if (closed) throw new HttpFailure(503, 'SERVER_CLOSED');
    if (streams.size >= limits.maxStreams) throw new HttpFailure(429, 'STREAM_LIMIT');
    const controller = new AbortController();
    const iterator = open(controller.signal);
    let sink: ReadableStreamDefaultController<Uint8Array>;
    let ended = false; let pending: Promise<IteratorResult<RunEvent>> | undefined;
    const finish = (): void => {
      if (ended) return;
      ended = true; controller.abort(); clearTimeout(timer); streams.delete(finish);
      request.signal.removeEventListener('abort', finish);
      try { sink.close(); } catch { /* Consumer cancellation may already have closed the stream. */ }
      void iterator.return?.().catch(() => {});
    };
    const timer = setTimeout(finish, Math.max(0, Math.min(limits.streamDurationMs, identity.expiresAtMs - Date.now())));
    streams.add(finish);
    const stream = new ReadableStream<Uint8Array>({
      start(value) { sink = value; },
      async pull(value) {
        if (ended) return;
        let beat: ReturnType<typeof setTimeout> | undefined;
        try {
          if (!pending) { pending = iterator.next(); pending.catch(() => {}); }
          const next = await Promise.race([pending, new Promise<'beat'>(resolve => { beat = setTimeout(resolve, limits.streamHeartbeatMs, 'beat'); })]);
          if (ended) return;
          if (next === 'beat') { value.enqueue(encoder.encode(': keep-alive\n\n')); return; }
          pending = undefined;
          if (next.done) { onDone?.(); finish(); return; }
          const event = JSON.stringify(jsonValue(next.value, { maxBytes: 16_384 }));
          value.enqueue(encoder.encode(`id: ${next.value.sequence}\nevent: ${next.value.type}\ndata: ${event}\n\n`));
        } catch (error) {
          const code: ServerErrorCode = error instanceof HttpFailure && error.code === 'RUN_RECORDS_UNAVAILABLE' ? error.code : 'OBSERVATION_FAILED';
          if (!ended) value.enqueue(encoder.encode(`event: stream.error\ndata: ${JSON.stringify({ code, message: errorMessages[code] })}\n\n`));
          finish();
        } finally { clearTimeout(beat); }
      },
      cancel() { finish(); },
    }, { highWaterMark: 1 });
    request.signal.addEventListener('abort', finish, { once: true });
    if (request.signal.aborted) finish();
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' } });
  };
  /** Recorded events of a run owned by another replica, polled until the run has ended and every event was read. */
  async function* recordedEvents(owner: string, runId: string, after: number, signal: AbortSignal): AsyncGenerator<RunEvent> {
    const records = runRecords!; let cursor = after;
    while (!signal.aborted) {
      const page = await recorded(() => records.events({ owner, runId, after: cursor, limit: 256, signal }), signal);
      if (!Array.isArray(page) || page.length > 256) throw new HttpFailure(503, 'RUN_RECORDS_UNAVAILABLE');
      for (const item of page as readonly RunEvent[]) {
        const gap = item?.type === 'events.gap';
        if (!item || item.runId !== runId || !Number.isSafeInteger(item.sequence) || (gap ? item.sequence <= cursor || item.metadata?.['from'] !== cursor + 1
          || item.metadata?.['to'] !== item.sequence : item.sequence !== cursor + 1)) throw new HttpFailure(503, 'RUN_RECORDS_UNAVAILABLE');
        cursor = item.sequence; yield item;
        if (item.type === 'run.completed') return;
      }
      if (page.length === 256) continue;
      const record = await readRecord(owner, runId, signal);
      if (!record || (record.status !== 'running' && record.lastSequence <= cursor)) return;
      if (page.length === 0) await new Promise<void>(resolve => {
        const done = (): void => { clearTimeout(wait); signal.removeEventListener('abort', done); resolve(); };
        const wait = setTimeout(done, limits.runRecordPollMs); signal.addEventListener('abort', done, { once: true });
      });
    }
  }

  /** The run's public inspection: identity, status, budget and effect evidence. Every replica answers with this shape. */
  const inspection = (entry: Entry): JsonObject => {
    const view = entry.runtime.inspect(entry.handle);
    // A snapshot that is not JSON is an internal failure, not the caller's bad request.
    return jsonValue({ id: view.id, status: view.status, budget: view.budget, evidence: view.evidence }, { maxBytes: 4_194_304 }) as JsonObject;
  };
  /** In-flight owner loops; close() lets them record final outcomes for a bounded time. */
  const persisters = new Set<Promise<void>>(); const persisterStop = new AbortController();
  /**
   * The owner's side of a durable run: record events in order, the snapshot and finally the outcome; renew the lease;
   * and act on cancel requests from other replicas. A write that fails is retried with backoff; if the lease lapses
   * meanwhile, another replica settles the run as outcome_unknown and this owner, told it lost the run, cancels it.
   */
  const persist = (entry: Entry): Promise<void> => {
    const records = runRecords!; const runId = entry.handle.id; const owner = entry.owner;
    const buffer: RunEvent[] = []; let observed = false; let wake: (() => void) | undefined;
    const notify = (): void => { const resume = wake; wake = undefined; resume?.(); };
    void (async () => {
      try { for await (const event of entry.handle.observe({ after: 0, signal: persisterStop.signal })) { buffer.push(event); notify(); } }
      catch { /* The final write still records the outcome; readers see the missing events as a gap. */ }
      finally { observed = true; notify(); }
    })();
    void entry.handle.result().then(notify, notify);
    const call = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController(); const stop = (): void => controller.abort();
      const timer = setTimeout(stop, Math.max(1, Math.floor(limits.runLeaseMs / 3))); persisterStop.signal.addEventListener('abort', stop, { once: true });
      try { return await bounded(Promise.resolve().then(() => operation(controller.signal)), controller.signal); }
      finally { clearTimeout(timer); persisterStop.signal.removeEventListener('abort', stop); }
    };
    const task = (async () => {
      let lastWrite = Date.now(); let failures = 0;
      while (!persisterStop.signal.aborted) {
        const now = Date.now(); const ended = observed && entry.finished === true;
        try {
          if (buffer.length > 0 || ended || now - lastWrite >= limits.runLeaseMs / 3) {
            const events = buffer.slice(0, 256); const final = ended && events.length === buffer.length;
            const result = await call(signal => records.update({ owner, runId, replicaId, events, snapshot: inspection(entry),
              leaseExpiresAtMs: now + limits.runLeaseMs, ...(final ? { outcome: object(entry.outcome, 4_194_304) } : {}), signal })) as unknown;
            const written = result as { status?: unknown; cancelRequested?: unknown } | null;
            if (written?.status === 'lost') { entry.lost = true; entry.handle.cancel(); return; }
            if (written?.status !== 'written' || typeof written.cancelRequested !== 'boolean') throw new Error('invalid');
            buffer.splice(0, events.length); lastWrite = now; failures = 0;
            if (written.cancelRequested) entry.handle.cancel();
            if (final) return;
            if (buffer.length > 0 || (observed && entry.finished)) continue;
          } else {
            const record = recordView(await call(signal => records.read({ owner, runId, signal })), runId);
            if (!record) throw new Error('missing');
            if (record.replicaId !== replicaId || record.status !== 'running') { entry.lost = true; entry.handle.cancel(); return; }
            if (record.cancelRequested) entry.handle.cancel();
            failures = 0;
          }
        } catch { failures = Math.min(failures + 1, 16); }
        const delay = failures > 0 ? Math.min(Math.floor(limits.runLeaseMs / 3), 100 * 2 ** failures) : limits.runRecordPollMs;
        await new Promise<void>(resolve => {
          const done = (): void => { clearTimeout(timer); persisterStop.signal.removeEventListener('abort', done); wake = undefined; resolve(); };
          const timer = setTimeout(done, delay); persisterStop.signal.addEventListener('abort', done, { once: true });
          // New events wake a healthy loop at once; after a failure the backoff is kept.
          if (failures === 0) wake = done;
        });
      }
    })();
    persisters.add(task); void task.finally(() => { persisters.delete(task); });
    return task;
  };
  /** A 409 for a workflow command; with read access the caller also learns the run's current revision. */
  const workflowConflict = async (identity: ServerIdentity, runId: string, signal: AbortSignal): Promise<HttpFailure> => {
    if (!workflowViews || !identity.capabilities.includes('workflows:read') || signal.aborted) return new HttpFailure(409, 'WORKFLOW_CONFLICT');
    try {
      const item = await bounded(Promise.resolve().then(() => workflowViews.inspect(Object.freeze({ scope: identity.scope, agentIds: identity.agentIds, runId, signal }))), signal);
      if (item !== null) return new HttpFailure(409, 'WORKFLOW_CONFLICT', { currentRevision: workflowRecord(item, runId).revision });
    } catch { /* The conflict stands without the hint. */ }
    return new HttpFailure(409, 'WORKFLOW_CONFLICT');
  };

  const route = async (request: Request, signal: AbortSignal): Promise<Response> => {
    const received = new URL(request.url);
    // Mounted behind a trusted router, only the path and query are taken from the request; the destination is always
    // publicOrigin and no header can change it.
    if ((options.mounted !== true && received.origin !== publicOrigin) || received.username || received.password || received.hash) throw new HttpFailure(400, 'INVALID_DESTINATION');
    // Assigned field by field: a path such as `//other.host/` must never be resolved as a new authority.
    const url = new URL(publicOrigin); url.pathname = received.pathname; url.search = received.search;
    // Console assets are static and data-free; module scripts carry an Origin header even when same-origin.
    if (options.inspector === true && !url.search) { const asset = inspectorAsset(request.method, url.pathname); if (asset) return asset; }
    const requestOrigin = request.headers.get('origin');
    // A page served from the public origin is a same-origin caller; other browser origins need allowedOrigins.
    if (requestOrigin !== null && requestOrigin !== publicOrigin && !origins.has(requestOrigin)) throw new HttpFailure(403, 'ORIGIN_DENIED');
    // A preflight is validated as the request it announces: the same query rules apply, so query credentials still fail,
    // but a legitimate paginated GET can be preflighted.
    const effectiveMethod = request.method === 'OPTIONS' ? request.headers.get('access-control-request-method') ?? '' : request.method;
    const eventMatch = /^\/v1\/runs\/([a-f0-9-]{36})\/events$/.exec(url.pathname);
    const catalogQuery = effectiveMethod === 'GET' && url.pathname === '/v1/tools';
    const humanListQuery = effectiveMethod === 'GET' && url.pathname === '/v1/human-requests';
    const workflowListQuery = effectiveMethod === 'GET' && url.pathname === '/v1/workflow-runs';
    if ([...url.searchParams.keys()].some(key => effectiveMethod !== 'GET' || (eventMatch ? key !== 'after' : catalogQuery || humanListQuery ? !['after', 'limit'].includes(key) : workflowListQuery ? !['after', 'limit', 'view'].includes(key) : true))
      || url.searchParams.getAll('after').length > 1 || url.searchParams.getAll('limit').length > 1 || url.searchParams.getAll('view').length > 1) throw new HttpFailure(400, 'INVALID_QUERY');
    if (request.method === 'OPTIONS') {
      if (!requestOrigin || !['GET', 'POST'].includes(request.headers.get('access-control-request-method') ?? '')) throw new HttpFailure(403, requestOrigin ? 'PREFLIGHT_DENIED' : 'ORIGIN_DENIED');
      const headers = (request.headers.get('access-control-request-headers') ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (headers.some(value => !['authorization', 'content-type', 'idempotency-key'].includes(value))) throw new HttpFailure(403, 'PREFLIGHT_DENIED');
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key' } });
    }
    if (request.method === 'GET' && url.pathname === '/healthz' && options.publicLiveness === true) return response({ status: 'ok' });
    const identity = await session(request, signal);
    if (closed) throw new HttpFailure(503, 'SERVER_CLOSED');
    const owner = canonical(identity.scope as unknown as JsonValue);
    if (workflowListQuery) {
      requireCapability(identity, 'workflows:read'); if (!workflowIndex) throw new HttpFailure(404, 'NOT_ENABLED', { option: 'workflowIndex' });
      const after = url.searchParams.get('after'); const limitText = url.searchParams.get('limit') ?? '20';
      if ((after !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(after)) || !/^\d+$/.test(limitText)) throw new HttpFailure(400, 'INVALID_CURSOR');
      const limit = Number(limitText); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpFailure(400, 'INVALID_CURSOR');
      const view = url.searchParams.get('view') ?? 'active'; if (view !== 'active' && view !== 'settled') throw new HttpFailure(400, 'INVALID_QUERY');
      const settled = view === 'settled';
      if (workflowOperations >= limits.maxWorkflowOperations) throw new HttpFailure(429, 'WORKFLOW_LIMIT'); workflowOperations++;
      const operation = Promise.resolve().then(() => workflowIndex.list(Object.freeze({ scope: identity.scope, agentIds: identity.agentIds,
        after, limit, signal, ...(settled ? { view: 'settled' as const } : {}) }))).finally(() => { workflowOperations--; });
      let supplied: unknown; try { supplied = await bounded(operation, signal); }
      catch (error) { if (error instanceof HttpFailure && error.status === 408) throw error; throw new HttpFailure(503, 'WORKFLOW_UNAVAILABLE'); }
      let page: JsonObject; try { page = object(supplied, 524_288); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
      workflowExact(page, ['items', 'next']);
      if (!Array.isArray(page['items']) || page['items'].length > limit || (page['next'] !== null
        && (typeof page['next'] !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(page['next']) || page['next'] === after)))
        throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
      const items = page['items'].map(item => workflowIndexRecord(item, settled)); if (new Set(items.map(item => item.runId)).size !== items.length)
        throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
      assertActive(signal); requireCapability(identity, 'workflows:read'); return response({ items, next: page['next'] });
    }
    const fleetMatch = /^\/v1\/workflow-fleet(?:\/(hold|release|sweeps\/pause|sweeps\/resume))?$/.exec(url.pathname);
    if (fleetMatch && request.method === (fleetMatch[1] === undefined ? 'GET' : 'POST')) {
      const action = fleetMatch[1] ?? 'inspect'; const capability = action === 'inspect' ? 'workflows:read' : 'workflows:fleet';
      requireCapability(identity, capability); if (!workflowFleet) throw new HttpFailure(404, 'NOT_ENABLED', { option: 'workflowFleet' });
      let cursor: JsonObject | null = null; let limit = 0; const sweep = action.startsWith('sweeps/');
      if (action !== 'inspect') {
        const data = await body(request, signal);
        if (!sweep) exact(data, []);
        else {
          exact(data, ['cursor', 'limit']);
          if (typeof data['limit'] !== 'number' || !Number.isSafeInteger(data['limit']) || data['limit'] < 1 || data['limit'] > 128) throw new HttpFailure(400, 'INVALID_REQUEST', { message: 'limit must be an integer from 1 to 128, and cursor null or the nextCursor the server returned.' });
          limit = data['limit']; if (data['cursor'] !== null) cursor = object(data['cursor'], 4_096);
        }
      }
      if (workflowOperations >= limits.maxWorkflowOperations) throw new HttpFailure(429, 'WORKFLOW_LIMIT'); workflowOperations++;
      const base = Object.freeze({ scope: identity.scope, agentIds: identity.agentIds, actorId: identity.scope.principalId, signal });
      const call = (): Promise<unknown> => action === 'inspect' ? workflowFleet.inspect(base) : action === 'hold' ? workflowFleet.hold(base)
        : action === 'release' ? workflowFleet.release(base)
          : workflowFleet.sweep(Object.freeze({ ...base, phase: action === 'sweeps/pause' ? 'pause' as const : 'resume' as const, cursor, limit }));
      const operation = Promise.resolve().then(call).finally(() => { workflowOperations--; });
      let result: unknown;
      try { result = await bounded(operation, signal); } catch (error) { if (error instanceof HttpFailure && error.status === 408) throw error; throw new HttpFailure(503, 'WORKFLOW_UNAVAILABLE'); }
      assertActive(signal); requireCapability(identity, capability);
      if (sweep) {
        let raw: JsonObject; try { raw = object(result, 262_144); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
        if (raw['status'] === 'conflict' && Object.keys(raw).length === 1) throw new HttpFailure(409, 'FLEET_CONFLICT');
        workflowExact(raw, ['status', 'sweep']); if (raw['status'] !== 'applied') throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
        return response({ sweep: fleetSweep(raw['sweep'], limit) });
      }
      const fleet = fleetHold(result);
      if ((action === 'hold' && !fleet.held) || (action === 'release' && fleet.held)) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
      return response({ fleet });
    }
    const workflowMatch = /^\/v1\/workflow-runs\/([a-f0-9]{64})$/.exec(url.pathname);
    if (workflowMatch && request.method === 'GET') {
      requireCapability(identity, 'workflows:read'); if (!workflowViews) throw new HttpFailure(404, 'NOT_ENABLED', { option: 'workflowViews' });
      if (workflowOperations >= limits.maxWorkflowOperations) throw new HttpFailure(429, 'WORKFLOW_LIMIT');
      workflowOperations++;
      const operation = Promise.resolve().then(() => workflowViews.inspect(Object.freeze({ scope: identity.scope, agentIds: identity.agentIds,
        runId: workflowMatch[1]!, signal }))).finally(() => { workflowOperations--; });
      let item: WorkflowViewRecord | null;
      try { item = await bounded(operation, signal); } catch (error) { if (error instanceof HttpFailure && error.status === 408) throw error; throw new HttpFailure(503, 'WORKFLOW_UNAVAILABLE'); }
      if (item === null) throw new HttpFailure(404, 'WORKFLOW_RUN_NOT_FOUND'); const record = workflowRecord(item, workflowMatch[1]!);
      assertActive(signal); requireCapability(identity, 'workflows:read'); return response({ workflow: record });
    }
    const workflowControlMatch = /^\/v1\/workflow-runs\/([a-f0-9]{64})\/(cancel|approvals)$/.exec(url.pathname);
    if (workflowControlMatch && request.method === 'POST') {
      requireCapability(identity, 'workflows:control'); if (!workflowControls) throw new HttpFailure(404, 'NOT_ENABLED', { option: 'workflowControls' });
      const data = await body(request, signal); const action = workflowControlMatch[2]!;
      const fields = action === 'cancel' ? ['commandId', 'revision'] : ['commandId', 'revision', 'nodeId', 'approvalDigest', 'childRunId']; exact(data, fields);
      if (typeof data['commandId'] !== 'string' || !identifier.test(data['commandId']) || typeof data['revision'] !== 'number'
        || !Number.isSafeInteger(data['revision']) || data['revision'] < 1) throw new HttpFailure(400, 'INVALID_REQUEST', { message: commandFields });
      if (action === 'approvals' && (typeof data['nodeId'] !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(data['nodeId'])
        || typeof data['approvalDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(data['approvalDigest'])
        || (data['childRunId'] !== null && (typeof data['childRunId'] !== 'string' || !/^[a-f0-9]{64}$/.test(data['childRunId'])))))
        throw new HttpFailure(400, 'INVALID_REQUEST', { message: 'nodeId must be a workflow node id, approvalDigest a 64-character lowercase hex digest, and childRunId null or a workflow run id.' });
      if (workflowOperations >= limits.maxWorkflowOperations) throw new HttpFailure(429, 'WORKFLOW_LIMIT'); workflowOperations++;
      const common = { scope: identity.scope, agentIds: identity.agentIds, actorId: identity.scope.principalId, runId: workflowControlMatch[1]!,
        revision: data['revision'] as number, commandId: data['commandId'] as string, signal };
      const operation = Promise.resolve().then(() => action === 'cancel' ? workflowControls.cancel(Object.freeze(common))
        : workflowControls.approve(Object.freeze({ ...common, nodeId: data['nodeId'] as string, approvalDigest: data['approvalDigest'] as string,
          childRunId: data['childRunId'] as string | null }))).finally(() => { workflowOperations--; });
      let result: WorkflowControlResult;
      try { result = await bounded(operation, signal); } catch (error) { if (error instanceof HttpFailure && error.status === 408) throw error; throw new HttpFailure(503, 'WORKFLOW_UNAVAILABLE'); }
      assertActive(signal); requireCapability(identity, 'workflows:control');
      let raw: JsonObject; try { raw = object(result, 262_144); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
      if (raw['status'] === 'conflict' && Object.keys(raw).length === 1) throw await workflowConflict(identity, workflowControlMatch[1]!, signal);
      if (raw['status'] === 'not_found' && Object.keys(raw).length === 1) throw new HttpFailure(404, 'WORKFLOW_RUN_NOT_FOUND');
      workflowExact(raw, ['status', 'workflow']); if (raw['status'] !== 'applied') throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
      const record = workflowRecord(raw['workflow'], workflowControlMatch[1]!);
      if (record.revision < (data['revision'] as number)) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
      return response({ workflow: record });
    }
    const workflowSignalMatch = /^\/v1\/workflow-runs\/([a-f0-9]{64})\/signals$/.exec(url.pathname);
    if (workflowSignalMatch && request.method === 'POST') {
      requireCapability(identity, 'workflows:control'); if (!workflowSignals) throw new HttpFailure(404, 'NOT_ENABLED', { option: 'workflowSignals' });
      const data = await body(request, signal); exact(data, ['commandId', 'revision', 'signalId', 'signalName', 'value']);
      if (typeof data['commandId'] !== 'string' || !identifier.test(data['commandId']) || typeof data['revision'] !== 'number'
        || !Number.isSafeInteger(data['revision']) || data['revision'] < 1 || typeof data['signalId'] !== 'string' || !identifier.test(data['signalId'])
        || typeof data['signalName'] !== 'string' || !identifier.test(data['signalName'])) throw new HttpFailure(400, 'INVALID_REQUEST', { message: `${commandFields} signalId and signalName must be identifiers of the same form.` });
      let value: JsonValue; try { value = freezeJson(jsonValue(data['value'], { maxBytes: 4_096, maxDepth: 16, maxNodes: 1_024 })); }
      catch { throw new HttpFailure(400, 'INVALID_REQUEST', { message: 'value must be JSON of at most 4,096 bytes, 16 levels and 1,024 values.' }); }
      if (workflowOperations >= limits.maxWorkflowOperations) throw new HttpFailure(429, 'WORKFLOW_LIMIT'); workflowOperations++;
      const operation = Promise.resolve().then(() => workflowSignals.deliver(Object.freeze({ scope: identity.scope, agentIds: identity.agentIds,
        actorId: identity.scope.principalId, runId: workflowSignalMatch[1]!, revision: data['revision'] as number,
        commandId: data['commandId'] as string, signalId: data['signalId'] as string, signalName: data['signalName'] as string,
        value, signal }))).finally(() => { workflowOperations--; });
      let result: WorkflowControlResult;
      try { result = await bounded(operation, signal); } catch (error) { if (error instanceof HttpFailure && error.status === 408) throw error; throw new HttpFailure(503, 'WORKFLOW_UNAVAILABLE'); }
      assertActive(signal); requireCapability(identity, 'workflows:control');
      let raw: JsonObject; try { raw = object(result, 262_144); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
      if (raw['status'] === 'conflict' && Object.keys(raw).length === 1) throw await workflowConflict(identity, workflowSignalMatch[1]!, signal);
      if (raw['status'] === 'not_found' && Object.keys(raw).length === 1) throw new HttpFailure(404, 'WORKFLOW_RUN_NOT_FOUND');
      workflowExact(raw, ['status', 'workflow']); if (raw['status'] !== 'applied') throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
      const record = workflowRecord(raw['workflow'], workflowSignalMatch[1]!);
      if (record.revision < (data['revision'] as number)) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
      return response({ workflow: record });
    }
    const migrationMatch = /^\/v1\/workflow-runs\/([a-f0-9]{64})\/migrations(?:\/([A-Za-z0-9][A-Za-z0-9._-]{0,127}))?$/.exec(url.pathname);
    if (migrationMatch && (request.method === 'GET' || (request.method === 'POST' && migrationMatch[2] !== undefined))) {
      const runId = migrationMatch[1]!; const migrationId = migrationMatch[2];
      const capability = request.method === 'POST' ? 'workflows:migrate' as const : 'workflows:read' as const;
      requireCapability(identity, capability); if (!workflowMigrations) throw new HttpFailure(404, 'NOT_ENABLED', { option: 'workflowMigrations' });
      let data: JsonObject | undefined;
      if (request.method === 'POST') {
        data = await body(request, signal); exact(data, ['commandId', 'revision']);
        if (typeof data['commandId'] !== 'string' || !identifier.test(data['commandId']) || typeof data['revision'] !== 'number'
          || !Number.isSafeInteger(data['revision']) || data['revision'] < 1) throw new HttpFailure(400, 'INVALID_REQUEST', { message: commandFields });
      }
      if (workflowOperations >= limits.maxWorkflowOperations) throw new HttpFailure(429, 'WORKFLOW_LIMIT'); workflowOperations++;
      const base = { scope: identity.scope, agentIds: identity.agentIds, runId, signal };
      const operation = Promise.resolve().then((): Promise<unknown> => migrationId === undefined ? workflowMigrations.list(Object.freeze(base))
        : data === undefined ? workflowMigrations.plan(Object.freeze({ ...base, migrationId }))
          : workflowMigrations.apply(Object.freeze({ ...base, actorId: identity.scope.principalId, revision: data['revision'] as number,
            commandId: data['commandId'] as string, migrationId }))).finally(() => { workflowOperations--; });
      let result: unknown;
      try { result = await bounded(operation, signal); } catch (error) { if (error instanceof HttpFailure && error.status === 408) throw error; throw new HttpFailure(503, 'WORKFLOW_UNAVAILABLE'); }
      assertActive(signal); requireCapability(identity, capability);
      if (migrationId === undefined) {
        if (result === null) throw new HttpFailure(404, 'WORKFLOW_RUN_NOT_FOUND');
        if (!Array.isArray(result) || result.length > 256) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
        const migrations = result.map(migrationRecord);
        if (new Set(migrations.map(item => item.id)).size !== migrations.length) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
        return response({ migrations });
      }
      if (data === undefined) {
        if (result === null) throw new HttpFailure(404, 'MIGRATION_NOT_FOUND');
        return response({ plan: migrationPlan(result, runId, migrationId) });
      }
      let raw: JsonObject; try { raw = object(result, 524_288); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
      if (raw['status'] === 'conflict' && Object.keys(raw).length === 1) throw await workflowConflict(identity, runId, signal);
      if (raw['status'] === 'not_found' && Object.keys(raw).length === 1) throw new HttpFailure(404, 'WORKFLOW_RUN_NOT_FOUND');
      if (raw['status'] === 'refused') {
        workflowExact(raw, ['status', 'plan']); const plan = migrationPlan(raw['plan'], runId, migrationId);
        if (plan.allowed) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
        return failureResponse(new HttpFailure(409, 'MIGRATION_REFUSED'), { plan: plan as unknown as JsonValue });
      }
      workflowExact(raw, ['status', 'plan', 'workflow']); if (raw['status'] !== 'applied') throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
      const plan = migrationPlan(raw['plan'], runId, migrationId); const record = workflowRecord(raw['workflow'], runId);
      if (!plan.allowed || record.revision <= (data['revision'] as number)) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
      return response({ plan, workflow: record });
    }
    // Continuation and operator pause share one exact revision-bound body; each has its own least-authority adapter.
    const workflowResumeMatch = /^\/v1\/workflow-runs\/([a-f0-9]{64})\/(resume|pause)$/.exec(url.pathname);
    if (workflowResumeMatch && request.method === 'POST') {
      requireCapability(identity, 'workflows:control');
      const callback = workflowResumeMatch[2] === 'pause' ? workflowPauses?.pause : workflowResumes?.resume;
      if (!callback) throw new HttpFailure(404, 'NOT_ENABLED', { option: workflowResumeMatch[2] === 'pause' ? 'workflowPauses' : 'workflowResumes' });
      const data = await body(request, signal); exact(data, ['commandId', 'revision']);
      if (typeof data['commandId'] !== 'string' || !identifier.test(data['commandId']) || typeof data['revision'] !== 'number'
        || !Number.isSafeInteger(data['revision']) || data['revision'] < 1) throw new HttpFailure(400, 'INVALID_REQUEST', { message: commandFields });
      if (workflowOperations >= limits.maxWorkflowOperations) throw new HttpFailure(429, 'WORKFLOW_LIMIT'); workflowOperations++;
      const operation = Promise.resolve().then(() => callback(Object.freeze({ scope: identity.scope, agentIds: identity.agentIds,
        actorId: identity.scope.principalId, runId: workflowResumeMatch[1]!, revision: data['revision'] as number,
        commandId: data['commandId'] as string, signal }))).finally(() => { workflowOperations--; });
      let result: WorkflowControlResult;
      try { result = await bounded(operation, signal); } catch (error) { if (error instanceof HttpFailure && error.status === 408) throw error; throw new HttpFailure(503, 'WORKFLOW_UNAVAILABLE'); }
      assertActive(signal); requireCapability(identity, 'workflows:control');
      let raw: JsonObject; try { raw = object(result, 262_144); } catch { throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID'); }
      if (raw['status'] === 'conflict' && Object.keys(raw).length === 1) throw await workflowConflict(identity, workflowResumeMatch[1]!, signal);
      if (raw['status'] === 'not_found' && Object.keys(raw).length === 1) throw new HttpFailure(404, 'WORKFLOW_RUN_NOT_FOUND');
      workflowExact(raw, ['status', 'workflow']); if (raw['status'] !== 'applied') throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
      const record = workflowRecord(raw['workflow'], workflowResumeMatch[1]!);
      if (record.revision < (data['revision'] as number)) throw new HttpFailure(503, 'WORKFLOW_TRANSPORT_INVALID');
      return response({ workflow: record });
    }
    if (request.method === 'GET' && url.pathname === '/v1/session') {
      // What this token may do and which optional APIs this server offers it, so a UI shows only usable views.
      const has = (prefix: string): boolean => identity.capabilities.some(capability => capability.startsWith(prefix));
      const features = [
        ...(has('humans:') && humanRequests ? ['humanRequests'] : []),
        ...(has('workflows:') ? ([['workflowIndex', workflowIndex], ['workflowViews', workflowViews], ['workflowControls', workflowControls],
          ['workflowSignals', workflowSignals], ['workflowResumes', workflowResumes], ['workflowPauses', workflowPauses], ['workflowFleet', workflowFleet],
          ['workflowMigrations', workflowMigrations]] as const).filter(([, enabled]) => enabled !== undefined).map(([name]) => name) : []),
        ...(has('runs:') && runRecords ? ['runRecords'] : []),
      ];
      return response({ session: { scope: identity.scope, agentIds: identity.agentIds, capabilities: identity.capabilities, expiresAtMs: identity.expiresAtMs, features } });
    }
    if (request.method === 'GET' && url.pathname === '/v1/agents') {
      requireCapability(identity, 'runs:read');
      return response({ agents: [...registry.values()].filter(config => identity.agentIds.includes(config.agent.id)).map(config => ({ id: config.agent.id, version: config.agent.version })) });
    }
    if (request.method === 'GET' && url.pathname === '/v1/operations/health') {
      requireCapability(identity, 'operations:read');
      const results = await Promise.all(healthChecks.map(async health => {
        if (healthOperations >= limits.maxHealthOperations) return { id: health.id, status: 'unavailable' as const };
        healthOperations++;
        const operation = Promise.resolve().then(() => health.check(Object.freeze({ signal, scope: identity.scope })))
          .finally(() => { healthOperations--; });
        try { return { id: health.id, status: await bounded(operation, signal) === true ? 'ready' as const : 'unavailable' as const }; }
        catch { return { id: health.id, status: 'unavailable' as const }; }
      }));
      assertActive(signal); requireCapability(identity, 'operations:read');
      const checks = [{ id: 'server', status: 'ready' as const }, ...results];
      const ready = checks.every(check => check.status === 'ready');
      return response({ status: ready ? 'ready' : 'degraded', checks }, ready ? 200 : 503);
    }
    if (request.method === 'GET' && url.pathname === '/v1/tools') {
      requireCapability(identity, 'operations:read');
      const afterText = url.searchParams.get('after') ?? '0'; const limitText = url.searchParams.get('limit') ?? '50';
      if (!/^\d+$/.test(afterText) || !/^\d+$/.test(limitText)) throw new HttpFailure(400, 'INVALID_CURSOR');
      const after = Number(afterText); const limit = Number(limitText);
      if (!Number.isSafeInteger(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpFailure(400, 'INVALID_CURSOR');
      const visible = toolCatalog.filter(tool => identity.agentIds.includes(tool.agentId));
      if (after > visible.length) throw new HttpFailure(400, 'INVALID_CURSOR');
      const tools = visible.slice(after, after + limit); const next = after + tools.length;
      return response({ tools, next: next < visible.length ? next : null });
    }
    if (request.method === 'GET' && url.pathname === '/v1/human-requests') {
      requireCapability(identity, 'humans:read'); if (!humanRequests) throw new HttpFailure(404, 'NOT_ENABLED', { option: 'humanRequests' });
      const after = url.searchParams.get('after'); const limitText = url.searchParams.get('limit') ?? '50';
      if ((after !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(after)) || !/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > 100) throw new HttpFailure(400, 'INVALID_CURSOR');
      const page = await humanCall(() => humanRequests.list(Object.freeze({ scope: identity.scope, agentIds: identity.agentIds, after, limit: Number(limitText), signal })), signal);
      let raw: JsonObject; try { raw = object(page, 1_048_576); exact(raw, ['items', 'next']); } catch { throw new HttpFailure(503, 'HUMAN_TRANSPORT_INVALID'); }
      if (!Array.isArray(raw['items']) || raw['items'].length > Number(limitText) || (raw['next'] !== null && (typeof raw['next'] !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw['next'])))) throw new HttpFailure(503, 'HUMAN_TRANSPORT_INVALID');
      const items = raw['items'].map(item => humanRecord(item, identity));
      if (new Set(items.map(item => item.id)).size !== items.length) throw new HttpFailure(503, 'HUMAN_TRANSPORT_INVALID');
      assertActive(signal); requireCapability(identity, 'humans:read'); return response({ items, next: raw['next'] });
    }
    const humanMatch = /^\/v1\/human-requests\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})(?:\/responses)?$/.exec(url.pathname);
    if (humanMatch && request.method === 'GET' && !url.pathname.endsWith('/responses')) {
      requireCapability(identity, 'humans:read'); if (!humanRequests) throw new HttpFailure(404, 'NOT_ENABLED', { option: 'humanRequests' });
      const item = await humanCall(() => humanRequests.inspect(Object.freeze({ scope: identity.scope, agentIds: identity.agentIds, id: humanMatch[1]!, signal })), signal);
      if (item === null) throw new HttpFailure(404, 'HUMAN_REQUEST_NOT_FOUND'); const record = humanRecord(item, identity);
      if (record.id !== humanMatch[1]) throw new HttpFailure(503, 'HUMAN_TRANSPORT_INVALID');
      assertActive(signal); requireCapability(identity, 'humans:read'); return response({ request: record });
    }
    if (humanMatch && request.method === 'POST' && url.pathname.endsWith('/responses')) {
      requireCapability(identity, 'humans:respond'); if (!humanRequests) throw new HttpFailure(404, 'NOT_ENABLED', { option: 'humanRequests' });
      const data = await body(request, signal); exact(data, ['commandId', 'requestDigest', 'value']);
      if (typeof data['commandId'] !== 'string' || !identifier.test(data['commandId']) || typeof data['requestDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(data['requestDigest'])) throw new HttpFailure(400, 'INVALID_REQUEST', { message: `${commandFields.replace(' and revision a positive integer', '')} requestDigest must be the request's 64-character lowercase hex digest.` });
      const item = await humanCall(() => humanRequests.respond(Object.freeze({ scope: identity.scope, agentIds: identity.agentIds, actorId: identity.scope.principalId,
        id: humanMatch[1]!, commandId: data['commandId'] as string, requestDigest: data['requestDigest'] as string, value: data['value']!, signal })), signal);
      const record = humanRecord(item, identity);
      if (record.id !== humanMatch[1] || record.digest !== data['requestDigest'] || record.status === 'waiting') throw new HttpFailure(503, 'HUMAN_TRANSPORT_INVALID');
      assertActive(signal); requireCapability(identity, 'humans:respond'); return response({ request: record });
    }
    if (request.method === 'POST' && url.pathname === '/v1/runs') {
      requireCapability(identity, 'runs:submit');
      const key = request.headers.get('idempotency-key') ?? '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) throw new HttpFailure(400, 'IDEMPOTENCY_KEY_REQUIRED');
      const data = await body(request, signal, runBodyBytes); exact(data, 'media' in data ? ['agentId', 'input', 'media'] : ['agentId', 'input']);
      const agentId = data['agentId'];
      if (typeof agentId !== 'string' || !identity.agentIds.includes(agentId) || !registry.has(agentId)) throw new HttpFailure(404, 'AGENT_NOT_FOUND');
      const config = registry.get(agentId)!;
      // Media is checked here against the agent's policy and limits, so a refusal says exactly why.
      const media = await submittedMedia(data['media'], identity.scope, signal);
      try { admitMedia(media, config.agent.media, config.limits?.maxMediaBytes ?? 20_971_520, 'INVALID_INPUT', `Agent ${agentId}`); }
      catch (error) { throw new HttpFailure(400, 'INVALID_MEDIA', { message: error instanceof MayuraError ? error.message : 'The media was refused.' }); }
      const digestBytes = await crypto.subtle.digest('SHA-256', encoder.encode(canonical({ agentId, version: config.agent.version, input: data['input']!,
        ...(media.length > 0 ? { media: await mediaDigests(media) } : {}) })));
      const digest = [...new Uint8Array(digestBytes)].map(value => value.toString(16).padStart(2, '0')).join('');
      assertActive(signal); requireCapability(identity, 'runs:submit');
      if (closed) throw new HttpFailure(503, 'SERVER_CLOSED');
      const submissionKey = JSON.stringify([owner, key]);
      const previous = submissions.get(submissionKey) ?? await pendingSubmissions.get(submissionKey);
      if (previous === 'duplicate') throw new HttpFailure(409, 'SUBMISSION_OUTCOME_UNKNOWN');
      if (previous && typeof previous === 'object' && 'replay' in previous) {
        if (previous.digest !== digest) throw new HttpFailure(409, 'IDEMPOTENCY_CONFLICT');
        return response({ id: previous.replay, profile: 'ephemeral' }, 200);
      }
      if (previous) {
        if (previous.digest !== digest) throw new HttpFailure(409, 'IDEMPOTENCY_CONFLICT');
        return response({ id: previous.handle.id, profile: 'ephemeral' }, 200);
      }
      const expired = tombstones.get(submissionKey);
      if (expired !== undefined) throw new HttpFailure(expired === digest ? 410 : 409, expired === digest ? 'RUN_EXPIRED' : 'IDEMPOTENCY_CONFLICT');
      const runtimeKey = JSON.stringify([owner, agentId]);
      makeRoom(runtimeKey);
      if (runs.size >= limits.maxRuns) throw new HttpFailure(429, 'RUN_LIMIT');
      if (!runtimes.has(runtimeKey) && runtimes.size >= limits.maxRuntimes) throw new HttpFailure(429, 'RUNTIME_LIMIT');
      const start = async (): Promise<Entry | 'duplicate' | Replay> => {
        let claimed = false;
        try {
          if (runRecords) {
            const claim = await recorded(() => runRecords.claim({ owner, key, digest, replicaId, nowMs: Date.now(), signal }), signal) as unknown;
            const result = claim as { status?: unknown; digest?: unknown; runId?: unknown; claimedAtMs?: unknown } | null;
            if (result?.status === 'existing' && typeof result.digest === 'string' && /^[a-f0-9]{64}$/.test(result.digest)
              && (result.runId === null || (typeof result.runId === 'string' && /^[a-f0-9-]{36}$/.test(result.runId))) && Number.isSafeInteger(result.claimedAtMs)) {
              if (result.digest !== digest) throw new HttpFailure(409, 'IDEMPOTENCY_CONFLICT');
              // Another replica, or an earlier process, owns this key: replay its run, wait for it to start, or admit uncertainty.
              if (result.runId !== null) return { replay: result.runId as string, digest };
              if ((result.claimedAtMs as number) >= Date.now() - limits.runLeaseMs - leaseSkewMs) throw new HttpFailure(409, 'SUBMISSION_IN_PROGRESS');
              return 'duplicate';
            }
            if (result?.status !== 'claimed') throw new HttpFailure(503, 'RUN_RECORDS_UNAVAILABLE');
            claimed = true;
          }
          if (submissionJournal) {
            let claim: unknown;
            try { claim = await bounded(Promise.resolve().then(() => submissionJournal.claim(Object.freeze({ owner, key, digest, signal }))), signal); }
            catch (error) { if (error instanceof HttpFailure && error.status === 408) throw error; throw new HttpFailure(503, 'SUBMISSION_JOURNAL_UNAVAILABLE'); }
            const result = claim as { status?: unknown; digest?: unknown } | null;
            if (result?.status === 'existing' && typeof result.digest === 'string') {
              // A claim made by an earlier process: its ephemeral run is gone, so neither replay nor a new run is truthful.
              if (result.digest !== digest) throw new HttpFailure(409, 'IDEMPOTENCY_CONFLICT');
              return 'duplicate';
            }
            if (result?.status !== 'claimed') throw new HttpFailure(503, 'SUBMISSION_JOURNAL_UNAVAILABLE');
          }
          assertActive(signal); if (closed) throw new HttpFailure(503, 'SERVER_CLOSED');
          makeRoom(runtimeKey);
          if (runs.size >= limits.maxRuns) throw new HttpFailure(429, 'RUN_LIMIT');
          let runtime = runtimes.get(runtimeKey);
          if (!runtime) {
            if (runtimes.size >= limits.maxRuntimes) throw new HttpFailure(429, 'RUNTIME_LIMIT');
            runtime = createRuntime({ profile: 'ephemeral', scope: identity.scope, permissions: config.permissions, ...(config.limits ? { limits: config.limits } : {}) });
            runtimes.set(runtimeKey, runtime);
          }
          claimed = false;
          const handle = runtime.submit(config.agent, { input: data['input'], ...(media.length > 0 ? { media } : {}) });
          const entry: Entry = { owner, agentId, digest, handle, runtime, runtimeKey, submissionKey };
          runs.set(handle.id, entry); submissions.set(submissionKey, entry);
          retained.set(runtimeKey, (retained.get(runtimeKey) ?? 0) + 1);
          void handle.result().then(outcome => {
            entry.outcome = outcome; entry.finished = true;
            if (closed) return;
            const timer = setTimeout(() => { retentionTimers.delete(timer); release(entry); }, limits.runRetentionMs);
            (timer as { unref?: () => void }).unref?.(); retentionTimers.add(timer);
          });
          if (runRecords) {
            // 202 means the run is recorded: without its record no other replica could find it, so it is stopped instead.
            try {
              await recorded(() => runRecords.start({ owner, key, runId: handle.id, agentId, replicaId, leaseExpiresAtMs: Date.now() + limits.runLeaseMs,
                snapshot: inspection(entry), signal }), signal);
            } catch (error) { handle.cancel(); release(entry); throw error; }
            entry.persisted = persist(entry);
          }
          return entry;
        } catch (error) {
          // A claim whose run never started is given back, so a retry with the same key can start it.
          if (claimed && runRecords) void Promise.resolve().then(() => runRecords.release({ owner, key, replicaId, signal: AbortSignal.timeout(limits.requestTimeoutMs) })).catch(() => {});
          throw error;
        }
      };
      const pending = start(); pendingSubmissions.set(submissionKey, pending);
      let started: Entry | 'duplicate' | Replay;
      try { started = await pending; } finally { pendingSubmissions.delete(submissionKey); }
      if (started === 'duplicate') throw new HttpFailure(409, 'SUBMISSION_OUTCOME_UNKNOWN');
      if ('replay' in started) return response({ id: started.replay, profile: 'ephemeral' }, 200);
      // Request mode: answer only once the run has ended and its outcome is recorded, so nothing runs after the response.
      if (runExecution === 'request') await started.persisted;
      return response({ id: started.handle.id, profile: 'ephemeral' }, 202);
    }
    const match = /^\/v1\/runs\/([a-f0-9-]{36})(?:\/(cancel|events))?$/.exec(url.pathname);
    if (!match) throw new HttpFailure(404, 'ROUTE_NOT_FOUND');
    const runId = match[1]!; const local = runs.get(runId);
    const entry = local && !local.lost && local.owner === owner && identity.agentIds.includes(local.agentId) ? local : undefined;
    const action = request.method === 'POST' && match[2] === 'cancel' ? 'cancel' : request.method === 'GET' && match[2] === 'events' ? 'events'
      : request.method === 'GET' && !match[2] ? 'read' : null;
    if (!action) throw new HttpFailure(405, 'METHOD_NOT_ALLOWED');
    if (!entry) {
      // Not held here: another replica's (or an earlier process's) run, answered from durable run records when configured.
      if (!runRecords || (local && !local.lost)) throw new HttpFailure(404, 'RUN_NOT_FOUND');
      requireCapability(identity, action === 'cancel' ? 'runs:cancel' : 'runs:read');
      if (action === 'cancel' && request.body !== null) throw new HttpFailure(400, 'INVALID_REQUEST', { message: 'Send the cancel request without a body.' });
      let cursor = 0;
      if (action === 'events') {
        const text = url.searchParams.get('after') ?? '0';
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new HttpFailure(400, 'INVALID_CURSOR'); cursor = Number(text);
      }
      const record = await readRecord(owner, runId, signal);
      if (!record || !identity.agentIds.includes(record.agentId)) throw new HttpFailure(404, 'RUN_NOT_FOUND');
      assertActive(signal); requireCapability(identity, action === 'cancel' ? 'runs:cancel' : 'runs:read');
      if (action === 'cancel') {
        if (record.status === 'running') {
          const records = runRecords;
          if (recordView(await recorded(() => records.requestCancel({ owner, runId, signal }), signal), runId) === null) throw new HttpFailure(404, 'RUN_NOT_FOUND');
        }
        return response({ id: runId, cancellationRequested: true }, 202);
      }
      if (action === 'events') return eventStream(stop => recordedEvents(owner, runId, cursor, stop), identity, request);
      return response({ ...record.snapshot, ...(record.outcome ? { outcome: record.outcome } : {}) });
    }
    if (action === 'cancel') {
      requireCapability(identity, 'runs:cancel');
      if (request.body !== null) throw new HttpFailure(400, 'INVALID_REQUEST', { message: 'Send the cancel request without a body.' });
      assertActive(signal); entry.handle.cancel();
      return response({ id: entry.handle.id, cancellationRequested: true }, 202);
    }
    if (action === 'events') {
      requireCapability(identity, 'runs:read');
      const cursor = url.searchParams.get('after') ?? '0';
      if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new HttpFailure(400, 'INVALID_CURSOR');
      assertActive(signal);
      return eventStream(stop => entry.handle.observe({ after: Number(cursor), signal: stop })[Symbol.asyncIterator](), identity, request,
        () => { if (entry.finished) entry.collected = true; });
    }
    requireCapability(identity, 'runs:read');
    if (entry.outcome) entry.collected = true;
    return response({ ...inspection(entry), ...(entry.outcome ? { outcome: entry.outcome } : {}) });
  };

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const allow = (result: Response): Response => {
        const requestOrigin = request.headers.get('origin');
        if (requestOrigin && requestOrigin !== publicOrigin && origins.has(requestOrigin)) {
          result.headers.set('Access-Control-Allow-Origin', requestOrigin); result.headers.set('Vary', 'Origin');
          result.headers.set('Access-Control-Expose-Headers', 'Retry-After');
        }
        return result;
      };
      if (closed) return allow(failureResponse(new HttpFailure(503, 'SERVER_CLOSED')));
      if (requests >= limits.maxRequests) return allow(failureResponse(new HttpFailure(429, 'REQUEST_LIMIT')));
      requests++;
      const controller = new AbortController();
      const abort = (): void => { controller.abort(); };
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      const submission = runExecution === 'request' && request.method === 'POST' && new URL(request.url).pathname === '/v1/runs';
      const timer = setTimeout(abort, submission ? submissionTimeoutMs : limits.requestTimeoutMs);
      let result: Response;
      try { result = await bounded(route(request, controller.signal).catch(error => {
        throw error instanceof HttpFailure ? error : new HttpFailure(500, 'INTERNAL_ERROR');
      }), controller.signal); }
      catch (error) {
        result = failureResponse(error instanceof HttpFailure ? error : new HttpFailure(503, 'SERVICE_UNAVAILABLE'));
      } finally { requests--; clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
      return allow(result);
    },
    async close(): Promise<void> {
      closed = true;
      for (const timer of retentionTimers) clearTimeout(timer); retentionTimers.clear();
      for (const finish of [...streams]) finish();
      await Promise.all([...runtimes.values()].map(runtime => runtime.close()));
      // Let owners record the outcomes of the runs just closed; a write still pending after this ends as outcome_unknown
      // once its lease lapses.
      if (persisters.size > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.allSettled([...persisters]), new Promise(resolve => { timer = setTimeout(resolve, Math.min(5_000, limits.runLeaseMs)); })]);
        clearTimeout(timer);
      }
      persisterStop.abort();
    },
  });
}
