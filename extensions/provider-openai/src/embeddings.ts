import { openAIEmbeddings as nativeEmbeddings, type OpenAIEmbeddingsOptions as NativeOptions } from 'mayura/provider-openai';
import type { MemoryEmbedder } from 'mayura/memory';
/** The existing bounded native OpenAI embedding contract, also available beside the SDK provider. */
export interface OpenAIEmbeddingsOptions extends NativeOptions {}
/** Price this adapter with ragEmbedder before using it in a scoped retriever or ingestion definition. */
export function openAIEmbeddings(options:OpenAIEmbeddingsOptions):MemoryEmbedder { return nativeEmbeddings(options); }
