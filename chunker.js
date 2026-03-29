import { OVCSSETTINGS } from './const.js';
import { debug } from './debug.js';
import crypto from 'node:crypto';
import path from 'node:path';
//
function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function getLanguageFromPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return OVCSSETTINGS.LANGUAGE_MAP[ext] || null;
}

function isSupportedFile(filePath) {
    return getLanguageFromPath(filePath) !== null;
}

function chunkCode(content, filePath, fileId, options = {}) {
    const {
        chunkSize = OVCSSETTINGS.CHUNK_SIZE,
        overlap = OVCSSETTINGS.CHUNK_OVERLAP
    } = options;

    const language = getLanguageFromPath(filePath);
    if (!language) {
        debug('Unsupported file type:', filePath);
        return [];
    }

    const lines = content.split('\n');
    const chunks = [];
    let chunkIndex = 0;
    let currentChunk = [];
    let currentTokenCount = 0;
    let chunkStartLine = 1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineTokens = estimateTokens(line);

        if (currentTokenCount + lineTokens > chunkSize && currentChunk.length > 0) {
            const chunkContent = currentChunk.join('\n');
            const chunkId = sha256(`${filePath}:${chunkIndex}`);

            chunks.push({
                id: chunkId,
                file_path: filePath,
                file_id: fileId,
                chunk_index: chunkIndex,
                content: chunkContent,
                start_line: chunkStartLine,
                end_line: chunkStartLine + currentChunk.length - 1,
                language: language,
                vector: [],
                updated_at: new Date().toISOString(),
                content_hash: sha256(chunkContent)
            });

            chunkIndex++;

            const overlapLines = Math.ceil(overlap / estimateAverageTokensPerLine(currentChunk));
            const keepLines = Math.min(overlapLines, currentChunk.length);
            currentChunk = currentChunk.slice(-keepLines);
            currentTokenCount = currentChunk.reduce((sum, l) => sum + estimateTokens(l), 0);
            chunkStartLine = chunkStartLine + currentChunk.length - keepLines;
        }

        currentChunk.push(line);
        currentTokenCount += lineTokens;
    }

    if (currentChunk.length > 0) {
        const chunkContent = currentChunk.join('\n');
        const chunkId = sha256(`${filePath}:${chunkIndex}`);

        chunks.push({
            id: chunkId,
            file_path: filePath,
            file_id: fileId,
            chunk_index: chunkIndex,
            content: chunkContent,
            start_line: chunkStartLine,
            end_line: chunkStartLine + currentChunk.length - 1,
            language: language,
            vector: [],
            updated_at: new Date().toISOString(),
            content_hash: sha256(chunkContent)
        });
    }

    debug(`Created ${chunks.length} chunks for ${filePath}`);
    return chunks;
}

function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

function estimateAverageTokensPerLine(lines) {
    if (lines.length === 0) return 10;
    const totalTokens = lines.reduce((sum, l) => sum + estimateTokens(l), 0);
    return totalTokens / lines.length;
}

function chunkText(text, maxChunkSize = OVCSSETTINGS.CHUNK_SIZE) {
    const chunks = [];
    const sentences = text.split(/(?<=[.!?])\s+/);
    let currentChunk = '';
    let currentTokens = 0;

    for (const sentence of sentences) {
        const sentenceTokens = estimateTokens(sentence);

        if (currentTokens + sentenceTokens > maxChunkSize && currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            currentChunk = '';
            currentTokens = 0;
        }

        currentChunk += sentence + ' ';
        currentTokens += sentenceTokens;
    }

    if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

export {
    chunkCode,
    chunkText,
    getLanguageFromPath,
    isSupportedFile,
    estimateTokens,
    sha256
};
