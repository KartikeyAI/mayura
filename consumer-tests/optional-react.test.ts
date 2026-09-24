import { useMayuraHumanRequest, useMayuraRun, useMayuraRunActions, type MayuraRunActions } from '@mayura/client-react';
import type { HeadlessRunState, HeadlessRunStore } from '@mayura/client/headless';
import type { RemoteHumanRequest } from '@mayura/client';

/** Compile-only public hook signatures contain Mayura contracts without requiring React declarations. */
export function consumeReactBindings(store: HeadlessRunStore, request: RemoteHumanRequest, nowMs: number): HeadlessRunState {
  const state = useMayuraRun(store); const actions: MayuraRunActions = useMayuraRunActions(store); const human = useMayuraHumanRequest(request, nowMs);
  if (human.canRespond) void actions.refresh; return state;
}
