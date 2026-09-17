import { providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk } from '@freellmapi/shared/types.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';

const SEPTOR_BASE_URL = 'https://api.septorlabs.com/v1';

function checkModel(requested: string, returned: string): void {
  // Explicit auto routing may choose a model; a named model may not silently
  // substitute another one. Live Sep 10 probes returned MiniMax M2.5 for
  // eleven unrelated free IDs. Keep those routes out of the catalog and fail
  // over if a previously working named route starts doing the same.
  if (requested !== 'auto' && returned !== requested) {
    throw Object.assign(new Error('Septor Labs returned a different or missing model identity'), { status: 502 });
  }
}

export class SeptorProvider extends OpenAICompatProvider {
  constructor() {
    // /models rejects missing and invalid credentials (401), unlike Router9.
    super({ platform: 'septor', name: 'Septor Labs', baseUrl: SEPTOR_BASE_URL });
  }

  override async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    const response = await this.fetchWithTimeout(`${SEPTOR_BASE_URL}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (response.status === 401 || response.status === 403) {
      return this.validationResult(response);
    }

    if (response.ok) {
      return { valid: true };
    }

    throw providerHttpError(response, 'Septor Labs key validation inconclusive');
  }

  override async chatCompletion(
    apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const response = await super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    checkModel(modelId, response.model);
    return response;
  }

  override async *streamChatCompletion(
    apiKey: string, messages: ChatMessage[], modelId: string,
    options?: CompletionOptions, quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    for await (const chunk of super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext)) {
      // Verify before yielding even a role/content/tool preamble. Never label
      // an upstream substitution as the requested model in the client stream.
      checkModel(modelId, chunk.model);
      yield chunk;
    }
  }
}