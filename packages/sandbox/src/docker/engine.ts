/** A container to run, in the terms both engines understand. */
export interface RunConfig {
  readonly name: string;
  readonly image: string;
  readonly user: string;
  readonly workdir: string;
  readonly readOnlyRoot: boolean;
  /** tmpfs mounts: path to mount options. */
  readonly tmpfs: Readonly<Record<string, string>>;
  readonly pids: number;
  readonly memoryMiB: number;
  readonly cpus: number;
  /** `none`, or the default bridge network. */
  readonly network: 'none' | 'bridge';
  /** Container ports published on 127.0.0.1, each at a free host port. */
  readonly ports: readonly number[];
  /** Non-secret environment only (such as HOME): it is visible to anyone who can inspect the container. */
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly command: readonly string[];
}

export interface EngineExecOptions {
  /** Non-secret variables only, such as the command's tag; they are visible in the engine's process list. */
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array;
  readonly maxOutputBytes: number;
  /** Stops waiting: the engine call ends and returns what it has, without an exit code. */
  readonly signal: AbortSignal;
}
export interface EngineExecResult {
  readonly exitCode?: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly truncated: boolean;
}

/** How a Docker sandbox drives Docker: the CLI, or the Engine API. */
export interface DockerEngine {
  /** Whether the image is on this machine. Images are never pulled. */
  hasImage(image: string, signal: AbortSignal): Promise<boolean>;
  /** Creates and starts the container; resolves with its id. */
  run(config: RunConfig, signal: AbortSignal): Promise<string>;
  exec(container: string, command: readonly string[], options: EngineExecOptions): Promise<EngineExecResult>;
  /** The host port a published container port is on. */
  hostPort(container: string, port: number, signal: AbortSignal): Promise<number | undefined>;
  /** Stops and removes the container; succeeds when there is none. */
  remove(container: string, signal: AbortSignal): Promise<void>;
}

/** Collects a stream's bytes up to a bound, counting what it drops. */
export class Collector {
  private readonly chunks: Uint8Array[] = [];
  private kept = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(chunk: Uint8Array): void {
    const room = this.max - this.kept;
    if (chunk.byteLength > room) this.truncated = true;
    if (room <= 0) return;
    const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(Uint8Array.from(part)); this.kept += part.byteLength;
  }
  bytes(): Uint8Array {
    const data = new Uint8Array(this.kept); let offset = 0;
    for (const chunk of this.chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return data;
  }
}
