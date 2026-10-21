import './ui.css';
/** Released sandbox text only. No ANSI interpreter, HTML, shell execution or interactive host terminal. */
export function SandboxTerminal({ output, status }: { readonly output: string; readonly status: string }) {
  return <section className="mayura-ui" aria-label="Sandbox output"><h3>Sandbox · {status.slice(0,80)}</h3><pre tabIndex={0}>{output.slice(-64000)}</pre></section>;
}
