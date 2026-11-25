/** Version of the wire profile used by the conversation hook. */
export const AG_UI_PROTOCOL_VERSION = '1.0' as const;

export type AgUiJson =
  | null | boolean | number | string
  | readonly AgUiJson[]
  | { readonly [key: string]: AgUiJson };

export interface AgUiToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

/** Media uses opaque host file handles. */
export type AgUiContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image' | 'document';
      readonly source: {
        readonly type: 'file';
        readonly value: string;
        readonly provider: 'mayura';
        readonly mimeType: string;
      };
    };

export type AgUiMessage =
  | { readonly id: string; readonly role: 'user'; readonly content: string | readonly AgUiContentPart[] }
  | { readonly id: string; readonly role: 'assistant'; readonly content?: string; readonly toolCalls?: readonly AgUiToolCall[] }
  | { readonly id: string; readonly role: 'tool'; readonly toolCallId: string; readonly content: string; readonly error?: string };

export type AgUiResume =
  | { readonly interruptId: string; readonly status: 'resolved'; readonly payload: { readonly approved: boolean } }
  | { readonly interruptId: string; readonly status: 'cancelled' };

export type AgUiState = AgUiJson;

/** Revisioned state patches used by the host profile. */
export type AgUiStatePatchOperation =
  | { readonly op: 'add' | 'replace'; readonly path: string; readonly value: AgUiState }
  | { readonly op: 'remove'; readonly path: string };

export interface AgUiStateMetadata {
  readonly mayura: { readonly stateRevision: number; readonly previousStateRevision?: number };
}

export interface AgUiFrontendTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, AgUiJson>>;
}

export interface AgUiFrontendContinuation {
  readonly token: string;
  readonly claimId: string;
}

export interface AgUiFrontendDispatchMetadata {
  readonly mayura: { readonly frontend: { readonly token: string; readonly expiresAtMs: number; readonly claimPath: string } };
}

/** Request envelope accepted by the host. Frontend tool execution is outside the conversation hook. */
export interface AgUiRunInput {
  readonly threadId: string;
  readonly runId: string;
  readonly messages: readonly AgUiMessage[];
  readonly protocolVersion?: typeof AG_UI_PROTOCOL_VERSION;
  readonly state?: AgUiState;
  readonly tools?: readonly AgUiFrontendTool[];
  readonly forwardedProps?: { readonly mayuraFrontend: AgUiFrontendContinuation };
  readonly resume?: readonly AgUiResume[];
}

export interface AgUiInterrupt {
  readonly id: string;
  readonly reason: 'tool_call';
  readonly toolCallId: string;
  readonly expiresAt: string;
  readonly message: string;
  readonly responseSchema: Readonly<Record<string, AgUiJson>>;
}

/** Events in the Mayura-compatible wire profile consumed by the hook. */
export type AgUiEvent = { readonly timestamp?: number } & (
  | {
      readonly type: 'RUN_STARTED';
      readonly threadId: string;
      readonly runId: string;
      readonly metadata: { readonly mayura: { readonly runId: string } };
    }
  | {
      readonly type: 'RUN_FINISHED';
      readonly threadId: string;
      readonly runId: string;
      readonly outcome:
        | { readonly type: 'success'; readonly pendingToolCallIds?: readonly string[] }
        | { readonly type: 'cancelled' }
        | { readonly type: 'interrupt'; readonly interrupts: readonly AgUiInterrupt[] };
    }
  | { readonly type: 'CUSTOM'; readonly name: string; readonly value: AgUiJson }
  | { readonly type: 'RUN_ERROR'; readonly message: string; readonly code: string }
  | { readonly type: 'STATE_SNAPSHOT'; readonly snapshot: AgUiState; readonly metadata: AgUiStateMetadata }
  | { readonly type: 'STATE_DELTA'; readonly delta: readonly AgUiStatePatchOperation[]; readonly metadata: AgUiStateMetadata }
  | { readonly type: 'MESSAGES_SNAPSHOT'; readonly messages: readonly AgUiMessage[] }
  | { readonly type: 'STEP_STARTED' | 'STEP_FINISHED'; readonly stepName: string }
  | { readonly type: 'TEXT_MESSAGE_START'; readonly messageId: string; readonly role: 'assistant' }
  | { readonly type: 'TEXT_MESSAGE_CONTENT'; readonly messageId: string; readonly delta: string }
  | { readonly type: 'TEXT_MESSAGE_END'; readonly messageId: string }
  | {
      readonly type: 'TOOL_CALL_START';
      readonly toolCallId: string;
      readonly toolCallName: string;
      readonly parentMessageId: string;
      readonly metadata?: AgUiFrontendDispatchMetadata;
    }
  | { readonly type: 'TOOL_CALL_ARGS'; readonly toolCallId: string; readonly delta: string }
  | { readonly type: 'TOOL_CALL_END'; readonly toolCallId: string }
  | {
      readonly type: 'TOOL_CALL_RESULT';
      readonly messageId: string;
      readonly toolCallId: string;
      readonly content: string;
      readonly role: 'tool';
    }
);
