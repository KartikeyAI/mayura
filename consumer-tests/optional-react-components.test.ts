import { createElement, type ReactElement } from 'react';
import { MayuraHumanRequestCard, MayuraRunSummary, MayuraWorkflowGraph,
  type MayuraHumanRequestCardProps, type MayuraRunSummaryProps, type MayuraWorkflowGraphProps } from '@mayura/client-react/components';

export function consumeComponents(run: MayuraRunSummaryProps, workflow: MayuraWorkflowGraphProps,
  human: MayuraHumanRequestCardProps): readonly ReactElement[] {
  return [createElement(MayuraRunSummary, run), createElement(MayuraWorkflowGraph, workflow), createElement(MayuraHumanRequestCard, human)];
}
