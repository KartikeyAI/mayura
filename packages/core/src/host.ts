/** Explicit trusted-host integration APIs; never pass these capabilities into model or guard contexts. */
export { assertBudgetTicket } from './budget.js';
export { snapshotLocalGuards } from './local-guards.js';
export { registerManagedGuardDefinition, readManagedGuardDefinition, type ManagedGuardDescriptor, type ManagedGuardLimits } from './managed-guards.js';
export { evaluateLifecycleControl, evaluateLifecycleObserver, lifecycleHookTimeout, frozenView, snapshotHookOptions } from './lifecycle.js';
export { readServerSentEvents, streamModelCall, type ServerSentEvent, type ServerSentEventLimits } from './event-stream.js';
export { admitMedia, base64ToBytes, bytesToBase64, encodedMediaBytes, mediaDataUrl, mediaPolicy, readMediaResult, type ResolvedMediaPolicy } from './media.js';
export { checkStrictDefinition, modelToolNames, providerHttpFailure, strictJsonSchema } from './model-schema.js';
