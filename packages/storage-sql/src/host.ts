/**
 * Explicit trusted SQL-adapter plumbing, not an agent execution or authorization surface.
 * Both selected adapters share these exact reducer implementations and contracts identities.
 */
export { SchedulerDatabase, type SchedulerBackend, type SchedulerSession } from './scheduler-database.js';
/** The rows the scheduler state machine reads and writes, for stores that keep them outside this SQL layer. */
export type { SchedulerCandidateFilter, SchedulerEventRow, SchedulerHeldRow, SchedulerJobRow, SchedulerPersistence, SchedulerTransaction } from './scheduler-persistence.js';
export { ScheduledWorkflowDatabase } from './scheduled-database.js';
/** The rows the scheduled workflow state machine reads and writes besides the scheduler's. */
export type { ScheduledPersistence, ScheduledTransaction, WorkflowOwnerRow, WorkflowWaitTargetRow } from './scheduled-persistence.js';
export type { AggregateRow } from './aggregate-session.js';
export type { CompletionRow } from './execution-completions.js';
export { ExecutionWaitDatabase } from './execution-wait-database.js';
/** The rows the execution wait state machine reads and writes. */
export type { ExecutionStreamRow, ExecutionWaitEventRow, ExecutionWaitPersistence, ExecutionWaitRow, ExecutionWaitTargetRow, ExecutionWaitTransaction } from './execution-wait-persistence.js';
export { DurableBudgetDatabase } from './durable-budget-database.js';
/** The rows the durable budget reducer reads and writes. */
export type { BudgetEventRow, BudgetLedger, BudgetRootRow, DurableBudgetPersistence, DurableBudgetTransaction } from './durable-budget-persistence.js';
export { WorkflowTreeDatabase } from './workflow-tree-database.js';
/** The rows the workflow tree state machine reads and writes besides the scheduled workflow and budget ones. */
export type { WorkflowTreeJobRow, WorkflowTreeMemberRow, WorkflowTreePersistence, WorkflowTreeTransaction } from './workflow-tree-persistence.js';
export { MemoryIndexDatabase } from './memory-database.js';
export { memoryIndexFacade } from '@mayura/storage-contracts';
export type { WorkflowTreeCancellationResult, WorkflowTreeChildAdmission, WorkflowTreeChildCancellationResult, WorkflowTreeClaimedTool, WorkflowTreeCompletedTool, WorkflowTreeMemberResult, WorkflowTreePreparedTool, WorkflowTreeReceiptResult, WorkflowTreeRecoveryResult, WorkflowTreeRenewedTool, WorkflowTreeRootSnapshot, WorkflowTreeRootSubmission, WorkflowTreeStartedTool } from '@mayura/storage-contracts';
export { schedulerFacade, type SchedulerMethod } from './scheduler-validation.js';
export { scheduledFacade, workflowGraphFacade, type ScheduledMethod } from './scheduled-validation.js';
export { executionWaitFacade } from './execution-wait-validation.js';
export { workflowGraphDiscoveryFacade } from './workflow-graph-discovery-validation.js';
export { workflowTreeDiscoveryFacade } from './workflow-tree-discovery-validation.js';
export { durableBudgetFacade } from './durable-budget-validation.js';
/** The durable budget arithmetic, shared by stores that do not use this SQL layer, so every store charges alike. */
export { initialDurableBudgetState, reduceDurableBudgetState, type DurableBudgetMutation, type DurableBudgetReduction } from './durable-budget-state.js';
export { workflowTreeCommand, workflowTreeFacade } from './workflow-tree-validation.js';
export { initializeOwnership, ownedRun, writerRequired } from './aggregate-session.js';
export { createCommand, updateCommand, migrateCommand, identifier, cursor, submissionDigest, nextCounter, storedObject, EVENT_PAGE_SIZE } from './validation.js';
/**
 * The Mayura store on databases without interactive transactions: the same state machines, run as optimistic
 * transactions over documents. An adapter implements `DocumentBackend`.
 */
export { createDocumentStore, type DocumentStore, type DocumentStoreOptions } from './document/store.js';
export type { DocumentBackend, DocumentKey, DocumentRange, DocumentTransactionOptions, DocumentWrite, StoredDocument } from './document/session.js';
export { memoryDocumentBackend } from './document/memory-backend.js';
export { bounds as documentRangeBounds, compareKeys as compareDocumentKeys } from './document/keys.js';
