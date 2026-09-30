// Types for the test-only document fixtures in document.mjs.
export declare function sqliteD1(filename: string): Promise<{
  prepare(sql: string): { bind(...values: unknown[]): unknown; all<T = Record<string, unknown>>(): Promise<{ results?: T[] }> };
  batch(statements: unknown[]): Promise<{ results?: unknown[] }[]>;
  close(): void;
}>;
export declare function documentKey(...parts: (string | number)[]): string;
