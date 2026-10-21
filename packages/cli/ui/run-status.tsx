import { MayuraRunSummary, type MayuraRunSummaryProps } from 'mayura/client-react/components';
import './ui.css';
/** Content-free status and actual budget from a caller-owned authenticated run store. */
export function RunStatus(props: MayuraRunSummaryProps) { return <section className="mayura-ui"><MayuraRunSummary {...props} /></section>; }
