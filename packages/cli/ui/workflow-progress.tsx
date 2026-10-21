import { MayuraWorkflowGraph, type MayuraWorkflowGraphProps } from 'mayura/client-react/components';
import './ui.css';
/** Rendering this projection never dispatches, retries or approves a workflow. */
export function WorkflowProgress(props: MayuraWorkflowGraphProps) { return <section className="mayura-ui"><MayuraWorkflowGraph {...props} /></section>; }
