import { describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { defineWorkflow } from '../src/definition.js';
import { assertWorkflowTree, defineWorkflowTree, treeManifest, type WorkflowTreeDefinition } from '../src/children-definition.js';

const schema: Schema<JsonValue> = {'~standard':{version:1,vendor:'tree-test',validate:value=>({value:value as JsonValue})}};
const tool = defineTool({id:'fixture/tool',version:'1',description:'Fixture.',input:schema,output:schema,effects:'none',capabilities:[],costMicros:2,execute:value=>value});
const leaf = defineWorkflow({id:'leaf',version:'1',input:schema,output:schema,nodes:[{kind:'tool',id:'work',tool,input:{kind:'input',path:[]}}],result:{kind:'step',stepId:'work',path:[]}});
const options = {id:'root',version:'1',input:schema,output:schema,nodes:[{kind:'child' as const,id:'child',workflow:leaf,input:{kind:'input' as const,path:[]},
  policy:{permissions:['tool:fixture/tool'],maxCostMicros:2,maxCalls:1,maxOutputBytes:1_024,approvalTtlMs:1_000},resources:{work:['resource/a']}}],result:{kind:'step' as const,stepId:'child',path:[]}};

describe('workflow tree public authoring contract', () => {
  it('creates genuine immutable format-4 definitions with pinned leaf metadata', () => {
    const definition = defineWorkflowTree(options); const manifest = treeManifest(definition);
    expect(definition).toMatchObject({format:4,id:'root',nodes:[{kind:'child',workflow:leaf}]});
    expect(manifest).toMatchObject({format:4,graph:[{kind:'child',workflow:{id:'leaf'},resources:{work:['resource/a']}}]});
    expect(definition.digest).toMatch(/^[a-f0-9]{64}$/); expect(definition.digest).not.toBe(leaf.digest);
    expect(Object.isFrozen(definition)).toBe(true); expect(Object.isFrozen(definition.nodes[0])).toBe(true);
    expect(() => assertWorkflowTree({...definition})).toThrow();
  });

  it('rejects structural leaf forgeries and recursive tree definitions', () => {
    expect(() => defineWorkflowTree({...options,nodes:[{...options.nodes[0]!,workflow:{...leaf}}]} as never)).toThrow();
    const tree = defineWorkflowTree(options);
    expect(() => defineWorkflowTree({...options,nodes:[{...options.nodes[0]!,workflow:tree}]} as never)).toThrow();
    if (false) {
      // @ts-expect-error A structural value lacks the private format-4 brand.
      const forged: WorkflowTreeDefinition = options;
      // @ts-expect-error Required children accept only genuine format-2 workflows.
      defineWorkflowTree({...options,nodes:[{...options.nodes[0]!,workflow:tree}]});
      void forged;
    }
  });
});
