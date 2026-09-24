import { anthropicMessages, type AnthropicMessagesOptions } from '@mayura/provider-anthropic';
import { openAICompatibleChat, type OpenAICompatibleChatOptions } from '@mayura/provider-openai';

const schema: AnthropicMessagesOptions['outputJsonSchema'] = {
  type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false,
};
const anthOptions: AnthropicMessagesOptions = { apiKey: 'explicit', model: 'claude-fixture', outputJsonSchema: schema,
  maxCostMicros: 10, pricing: { inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 },
  fetch: async () => new Response(JSON.stringify({ type: 'message', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'text', text: '{"answer":1}' }], usage: { input_tokens: 1, output_tokens: 1 } })) };
const localOptions: OpenAICompatibleChatOptions = { endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'local',
  outputJsonSchema: schema, maxCostMicros: 0, pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
  fetch: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"answer":1}' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 } })) };
anthropicMessages(anthOptions); openAICompatibleChat(localOptions);
// @ts-expect-error Hosted provider credentials are explicit and required.
anthropicMessages({ model: 'missing-credential', outputJsonSchema: schema, maxCostMicros: 0, pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 } });
// @ts-expect-error Local-compatible destinations are explicit and required.
openAICompatibleChat({ model: 'missing-endpoint', outputJsonSchema: schema, maxCostMicros: 0, pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 } });
