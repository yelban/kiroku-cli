import { createLogger } from '../shared/logger.js';

const log = createLogger('embedder');
let _pipeline = null;

export async function initEmbedder(embeddingConfig) {
  if (_pipeline) return;

  const { pipeline, env } = await import('@huggingface/transformers');

  // Set model cache directory
  const { MODEL_CACHE_DIR } = await import('../shared/paths.js');
  env.cacheDir = MODEL_CACHE_DIR;
  env.allowLocalModels = true;

  log.info({ model: embeddingConfig.model, dtype: embeddingConfig.dtype }, 'loading embedding model');
  _pipeline = await pipeline('feature-extraction', embeddingConfig.model, {
    dtype: embeddingConfig.dtype,
    revision: 'main',
  });
  log.info('embedding model loaded');
}

export async function embedTexts(texts) {
  if (!_pipeline) throw new Error('Embedder not initialized');
  if (texts.length === 0) return [];

  const results = [];
  // Process in batches to manage memory
  const batchSize = 16;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const output = await _pipeline(batch, { pooling: 'cls', normalize: true });

    // Convert to array of arrays
    for (let j = 0; j < batch.length; j++) {
      const embedding = Array.from(output[j].data).slice(0, 1024);
      results.push(embedding);
    }
  }

  return results;
}
