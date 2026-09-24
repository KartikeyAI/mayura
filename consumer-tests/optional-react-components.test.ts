import { createElement, type ReactElement } from 'react';
import { MayuraHumanRequestCard, MayuraHumanResponseForm, MayuraRunSummary, MayuraWorkflowGraph,
  type MayuraHumanRequestCardProps, type MayuraHumanResponseFormProps, type MayuraRunSummaryProps,
  type MayuraWorkflowGraphProps } from '@mayura/client-react/components';

export function consumeComponents(run: MayuraRunSummaryProps, workflow: MayuraWorkflowGraphProps,
  human: MayuraHumanRequestCardProps, form: MayuraHumanResponseFormProps): readonly ReactElement[] {
  return [createElement(MayuraRunSummary, run), createElement(MayuraWorkflowGraph, workflow), createElement(MayuraHumanRequestCard, human),
    createElement(MayuraHumanResponseForm, form)];
}
