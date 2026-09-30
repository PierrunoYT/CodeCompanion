import { providerForModel, SMALL_MODELS } from '@shared/models';
import type { SettingsStore } from '../settings';
import { AnthropicCompletionClient, AnthropicConversation, createAnthropicClient } from './anthropic';
import { createOpenAIClient, OpenAICompletionClient, OpenAIConversation } from './openai';
import { OpenAIResponsesConversation } from './openai_responses';
import { MissingApiKeyError, type CompletionClient, type Conversation, type SerializedConversation } from './types';

export * from './types';

// End-to-end tests point the app at a local mock API. Unset in normal use.
const TEST_ANTHROPIC_BASE_URL = process.env.CODECOMPANION_TEST_ANTHROPIC_URL || undefined;
// Only used when no custom base URL is set in settings, so the Responses API path can be tested.
const TEST_OPENAI_BASE_URL = process.env.CODECOMPANION_TEST_OPENAI_URL || undefined;

// Requests that are not part of a chat turn (titles) retry silently inside the SDK. Chat turns are retried by the
// agent loop instead, where the retry can be shown.
const BACKGROUND_RETRIES = 3;

// Creates conversations and small-model clients from the current settings and keys.
export class LlmService {
  constructor(private readonly settings: SettingsStore) {}

  createConversation(model = this.settings.get().model): Conversation {
    return this.build(model, [], this.defaultOpenAIApi());
  }

  restoreConversation(saved: SerializedConversation): Conversation {
    return this.build(saved.model, saved.messages, saved.api ?? 'chat');
  }

  // Prefers the provider of the selected model; falls back to whichever provider has a key. Returns null when no
  // key is configured, in which case background features (titles, re-ranking) are skipped.
  smallModel(): CompletionClient | null {
    const preferred = providerForModel(this.settings.get().model);
    const order = preferred === 'anthropic' ? (['anthropic', 'openai'] as const) : (['openai', 'anthropic'] as const);
    for (const provider of order) {
      if (provider === 'anthropic') {
        const key = this.settings.getSecret('anthropicApiKey');
        if (key) return new AnthropicCompletionClient(createAnthropicClient(key, TEST_ANTHROPIC_BASE_URL, BACKGROUND_RETRIES), SMALL_MODELS.anthropic);
      } else {
        const key = this.settings.getSecret('openaiApiKey');
        if (key) {
          return new OpenAICompletionClient(
            createOpenAIClient(key, this.settings.get().openaiBaseUrl || TEST_OPENAI_BASE_URL, BACKGROUND_RETRIES),
            SMALL_MODELS.openai,
          );
        }
      }
    }
    return null;
  }

  // OpenAI's own API gets the Responses API; custom OpenAI-compatible endpoints usually only implement Chat Completions.
  private defaultOpenAIApi(): 'chat' | 'responses' {
    return this.settings.get().openaiBaseUrl.trim() ? 'chat' : 'responses';
  }

  private build(model: string, messages: unknown[], openaiApi: 'chat' | 'responses'): Conversation {
    const settings = this.settings.get();
    if (providerForModel(model) === 'anthropic') {
      const key = this.settings.getSecret('anthropicApiKey');
      if (!key) throw new MissingApiKeyError('anthropic');
      return new AnthropicConversation(createAnthropicClient(key, TEST_ANTHROPIC_BASE_URL), {
        model,
        effort: settings.effort,
        messages: messages as never,
      });
    }
    const key = this.settings.getSecret('openaiApiKey');
    if (!key) throw new MissingApiKeyError('openai');
    const client = createOpenAIClient(key, settings.openaiBaseUrl || TEST_OPENAI_BASE_URL);
    return openaiApi === 'responses'
      ? new OpenAIResponsesConversation(client, model, settings.effort, messages as never)
      : new OpenAIConversation(client, model, messages as never);
  }
}
