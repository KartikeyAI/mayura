import './ui.css';
/** Input and output are text, deliberately not HTML, executable code or authoritative tool receipts. */
export function ToolCall({ name, status, input, result }: { readonly name: string; readonly status: string; readonly input: string; readonly result?: string }) {
  return <details className="mayura-ui"><summary>{name.slice(0,128)} · {status.slice(0,80)}</summary><h3>Requested input</h3><pre>{input.slice(0,16000)}</pre>
    {result === undefined ? null : <><h3>Released result</h3><pre>{result.slice(0,16000)}</pre></>}</details>;
}
