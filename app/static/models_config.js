const modelOptions = {
  'gpt-4-turbo': 'GPT-4 Turbo',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4': 'GPT-4',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
};

const defaultModel = 'claude-sonnet-5-5';
const defaultOpenAISmallModel = 'gpt-4o-mini';
const defaultAnthropicSmallModel = 'claude-haiku-4-5-20251001';

const EMBEDDINGS_VERSION = 'v1.9'; // when reindexing of code embedding is needed, update this version
const EMBEDDINGS_MODEL_NAME = 'text-embedding-ada-002';

module.exports = {
  modelOptions,
  defaultModel,
  defaultOpenAISmallModel,
  defaultAnthropicSmallModel,
  EMBEDDINGS_VERSION,
  EMBEDDINGS_MODEL_NAME,
};
