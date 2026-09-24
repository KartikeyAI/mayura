import { useMayuraHumanRequest, useMayuraRun, useMayuraRunActions, useMayuraRunActivity, type MayuraRunActions } from '@mayura/client-react';
import type { HeadlessRunState, HeadlessRunStore } from '@mayura/client/headless';
import type { RemoteHumanRequest } from '@mayura/client';

/** Compile-only public hook signatures contain Mayura contracts without requiring React declarations. */
export function consumeReactBindings(store: HeadlessRunStore, request: RemoteHumanRequest, nowMs: number): HeadlessRunState {
  const state = useMayuraRun(store); const actions: MayuraRunActions = useMayuraRunActions(store); const human = useMayuraHumanRequest(request, nowMs);
  const activity = useMayuraRunActivity(state); if (human.canRespond || activity.complete) void actions.refresh; return state;
}
