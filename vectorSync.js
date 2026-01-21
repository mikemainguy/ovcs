import { initVectorStore, addCodeChunks, addAstNodes, removeFileVectors, clearAllVectors, isInitialized } from './vectorStore.js';
import { initEmbeddings, generateEmbedding, isModelLoaded } from './embeddings.js';
import { chunkCode, isSupportedFile, sha256 } from './chunker.js';
import { parseFile, createSearchableText } from './astParser.js';
import { debug } from './debug.js';

let pwd = null;
let syncQueue = [];
let isProcessing = false;
let initialized = false;

async function initVectorSync(workingDir) {
    pwd = workingDir;

    try {
        await initVectorStore(pwd);
        await initEmbeddings(pwd);
        initialized = true;
        debug('Vector sync initialized');
    } catch (err) {
        debug('Error initializing vector sync:', err);
        initialized = false;
    }
}

async function syncFileToVectorDB(data, metadata) {
    if (!initialized) {
        debug('Vector sync not initialized, skipping');
        return;
    }

    if (!data.id || !isSupportedFile(data.id)) {
        debug('Skipping non-supported file:', data.id);
        return;
    }

    syncQueue.push({ type: 'sync', data, metadata });
    processQueue();
}

async function removeFileFromVectorDB(fileId) {
    if (!initialized) {
        debug('Vector sync not initialized, skipping');
        return;
    }

    syncQueue.push({ type: 'delete', fileId });
    processQueue();
}

async function processQueue() {
    if (isProcessing || syncQueue.length === 0) return;

    isProcessing = true;

    while (syncQueue.length > 0) {
        const item = syncQueue.shift();

        try {
            if (item.type === 'sync') {
                await processFileSync(item.data, item.metadata);
            } else if (item.type === 'delete') {
                await processFileDelete(item.fileId);
            }
        } catch (err) {
            debug('Error processing queue item:', err);
        }
    }

    isProcessing = false;
}

async function processFileSync(data, metadata) {
    const filePath = data.id;
    const fileId = sha256(filePath);

    await removeFileVectors(fileId);

    let content = '';
    if (data.base64) {
        content = Buffer.from(data.base64, 'base64').toString('utf-8');
    }

    if (!content || content.length === 0) {
        debug('No content to vectorize for:', filePath);
        return;
    }

    const codeChunks = chunkCode(content, filePath, fileId);

    for (const chunk of codeChunks) {
        try {
            const embedding = await generateEmbedding(chunk.content);
            chunk.vector = embedding;
        } catch (err) {
            debug('Error generating embedding for chunk:', err);
            chunk.vector = new Array(384).fill(0);
        }
    }

    if (codeChunks.length > 0) {
        await addCodeChunks(codeChunks);
    }

    const astNodes = parseFile(content, filePath, fileId);

    for (const node of astNodes) {
        try {
            const searchText = createSearchableText(node);
            const embedding = await generateEmbedding(searchText);
            node.vector = embedding;
        } catch (err) {
            debug('Error generating embedding for AST node:', err);
            node.vector = new Array(384).fill(0);
        }
    }

    if (astNodes.length > 0) {
        await addAstNodes(astNodes);
    }

    debug(`Synced file to vector DB: ${filePath} (${codeChunks.length} chunks, ${astNodes.length} AST nodes)`);
}

async function processFileDelete(fileId) {
    const hashedId = sha256(fileId);
    await removeFileVectors(hashedId);
    debug('Removed file from vector DB:', fileId);
}

async function reindexAll(db) {
    if (!initialized) {
        throw new Error('Vector sync not initialized');
    }

    debug('Starting full reindex...');

    await clearAllVectors();

    const allDocs = await db.allDocs({ include_docs: true });
    let processed = 0;
    let errors = 0;

    for (const row of allDocs.rows) {
        const doc = row.doc;

        if (doc.type === 'file' && doc.file && isSupportedFile(doc.file)) {
            try {
                let content = '';
                if (doc.base64) {
                    content = Buffer.from(doc.base64, 'base64').toString('utf-8');
                } else if (doc.revisions) {
                    const revisionKeys = Object.keys(doc.revisions);
                    if (revisionKeys.length > 0) {
                        const latestRevision = doc.revisions[revisionKeys[0]];
                        if (latestRevision.content) {
                            content = Buffer.from(latestRevision.content, 'base64').toString('utf-8');
                        }
                    }
                }

                if (content) {
                    const filePath = doc.file;
                    const fileId = sha256(filePath);

                    const codeChunks = chunkCode(content, filePath, fileId);

                    for (const chunk of codeChunks) {
                        const embedding = await generateEmbedding(chunk.content);
                        chunk.vector = embedding;
                    }

                    if (codeChunks.length > 0) {
                        await addCodeChunks(codeChunks);
                    }

                    const astNodes = parseFile(content, filePath, fileId);

                    for (const node of astNodes) {
                        const searchText = createSearchableText(node);
                        const embedding = await generateEmbedding(searchText);
                        node.vector = embedding;
                    }

                    if (astNodes.length > 0) {
                        await addAstNodes(astNodes);
                    }

                    processed++;
                }
            } catch (err) {
                debug('Error reindexing file:', doc.file, err);
                errors++;
            }
        }
    }

    debug(`Reindex complete: ${processed} files processed, ${errors} errors`);
    return { processed, errors };
}

function isVectorSyncInitialized() {
    return initialized;
}

export {
    initVectorSync,
    syncFileToVectorDB,
    removeFileFromVectorDB,
    reindexAll,
    isVectorSyncInitialized
};
