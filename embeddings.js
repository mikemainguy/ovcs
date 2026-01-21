import { pipeline, env } from '@xenova/transformers';
import { OVCSSETTINGS } from './const.js';
import { debug } from './debug.js';
import path from 'node:path';
import fs from 'node:fs';

let embeddingPipeline = null;
let modelLoading = null;

async function initEmbeddings(pwd) {
    if (embeddingPipeline) return embeddingPipeline;
    if (modelLoading) return modelLoading;

    const modelsPath = path.join(pwd, OVCSSETTINGS.ROOT_DIR, OVCSSETTINGS.MODELS_DIR);

    if (!fs.existsSync(modelsPath)) {
        fs.mkdirSync(modelsPath, { recursive: true });
    }

    env.cacheDir = modelsPath;
    env.localModelPath = modelsPath;

    debug('Loading embedding model:', OVCSSETTINGS.EMBEDDING_MODEL);

    modelLoading = pipeline('feature-extraction', OVCSSETTINGS.EMBEDDING_MODEL, {
        quantized: true
    });

    try {
        embeddingPipeline = await modelLoading;
        debug('Embedding model loaded successfully');
        modelLoading = null;
        return embeddingPipeline;
    } catch (err) {
        debug('Error loading embedding model:', err);
        modelLoading = null;
        throw err;
    }
}

async function generateEmbedding(text) {
    if (!embeddingPipeline) {
        throw new Error('Embedding pipeline not initialized. Call initEmbeddings first.');
    }

    try {
        const output = await embeddingPipeline(text, {
            pooling: 'mean',
            normalize: true
        });

        return Array.from(output.data);
    } catch (err) {
        debug('Error generating embedding:', err);
        throw err;
    }
}

async function generateEmbeddings(texts) {
    if (!embeddingPipeline) {
        throw new Error('Embedding pipeline not initialized. Call initEmbeddings first.');
    }

    const embeddings = [];
    for (const text of texts) {
        const embedding = await generateEmbedding(text);
        embeddings.push(embedding);
    }
    return embeddings;
}

function isModelLoaded() {
    return embeddingPipeline !== null;
}

export {
    initEmbeddings,
    generateEmbedding,
    generateEmbeddings,
    isModelLoaded
};
