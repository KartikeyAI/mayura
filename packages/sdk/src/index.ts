/**
 * The authoring facade: agents, tools, hooks and the runtime, plus `z` for their schemas. Optional infrastructure
 * never enters this import graph.
 */
export * from '@mayura/core';
export * from '@mayura/tools';
export * from '@mayura/runtime';
/**
 * Zod 4, so a project needs no separate schema library: `import { defineTool, z } from 'mayura'`. Any other Standard
 * Schema validator (including a project's own copy of Zod) works too; Mayura never checks where a schema comes from.
 */
export { z } from 'zod';
