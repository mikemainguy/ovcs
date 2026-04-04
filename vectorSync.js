import { initVectorStore, addCodeChunks, addAstNodes, removeFileVectors, clearAllVectors, isInitialized, getStats } from './vectorStore.js';
import { initEmbeddings, generateEmbedding, isModelLoaded } from './embeddings.js';
import { chunkCode, isSupportedFile, sha256 } from './chunker.js';
import { parseFile, createSearchableText } from './astParser.js';
import { OVCSSETTINGS } from './const.js';
import { debug } from './debug.js';
import fs from 'node:fs';
import * as path from 'node:path';

let pwd = null;
let syncQueue = [];
let isProcessing = false;
let initialized = false;

const IGNORE_DIRS = new Set(['.ovcs', 'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'coverage', '.next', '.nuxt']);

async function initVectorSync(workingDir) {
    pwd = workingDir;

    try {
        await initVectorStore(pwd);
        await initEmbeddings(pwd);
        initialized = true;

        const stats = await getStats();
        console.log(`[OVCS] Search engine ready (${stats.code_chunks} chunks, ${stats.ast_nodes} AST nodes in index)`);
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

    // Read content from disk
    let content = '';
    try {
        const resolvedPath = path.resolve(pwd || '.', filePath);
        if (fs.existsSync(resolvedPath)) {
            content = fs.readFileSync(resolvedPath, 'utf-8');
        }
    } catch (err) {
        debug('Error reading file for vectorization:', filePath, err.message);
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

    const astNodes = await parseFile(content, filePath, fileId);

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

function walkDirectory(dir, baseDir) {
    const results = [];

    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        debug('Error reading directory:', dir, err.message);
        return results;
    }

    for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            results.push(...walkDirectory(fullPath, baseDir));
        } else if (entry.isFile()) {
            const relativePath = path.relative(baseDir, fullPath);
            if (isSupportedFile(relativePath)) {
                results.push(relativePath);
            }
        }
    }

    return results;
}

async function indexExistingFiles() {
    if (!initialized || !pwd) {
        debug('Cannot index existing files — vector sync not initialized');
        return { indexed: 0, skipped: 0, errors: 0 };
    }

    const stats = await getStats();
    if (stats.code_chunks > 0) {
        console.log(`[OVCS] Search index already populated (${stats.code_chunks} chunks, ${stats.ast_nodes} AST nodes) — skipping startup indexing`);
        return { indexed: 0, skipped: 0, errors: 0, reason: 'already_indexed' };
    }

    const files = walkDirectory(pwd, pwd);
    console.log(`[OVCS] Indexing ${files.length} files for search...`);

    let indexed = 0;
    let errors = 0;

    for (const filePath of files) {
        try {
            await processFileSync({ id: filePath }, {});
            indexed++;
            if (indexed % 20 === 0) {
                console.log(`[OVCS] Indexing progress: ${indexed}/${files.length} files`);
            }
        } catch (err) {
            debug('Error indexing file:', filePath, err.message);
            errors++;
        }
    }

    console.log(`[OVCS] Indexing complete: ${indexed} files indexed${errors > 0 ? `, ${errors} errors` : ''}`);
    return { indexed, skipped: files.length - indexed - errors, errors };
}

async function reindexAll(db) {
    if (!initialized) {
        throw new Error('Vector sync not initialized');
    }

    console.log('[OVCS] Starting full reindex...');

    await clearAllVectors();

    // Try RxDB collection first, fall back to filesystem walk
    let filesToIndex = [];

    if (db) {
        try {
            const allDocs = await db.allDocs({ include_docs: true });
            filesToIndex = allDocs.rows
                .filter(row => row.doc.type === 'file' && row.doc.file && isSupportedFile(row.doc.file))
                .map(row => row.doc.file);
        } catch (err) {
            debug('Error reading from DB for reindex, falling back to filesystem:', err.message);
        }
    }

    if (filesToIndex.length === 0 && pwd) {
        debug('No files in DB — falling back to filesystem walk');
        filesToIndex = walkDirectory(pwd, pwd);
    }

    let processed = 0;
    let errors = 0;

    for (const filePath of filesToIndex) {
        try {
            let content = '';
            try {
                const resolvedPath = path.resolve(pwd || '.', filePath);
                if (fs.existsSync(resolvedPath)) {
                    content = fs.readFileSync(resolvedPath, 'utf-8');
                }
            } catch (err) {
                debug('Error reading file for reindex:', filePath, err.message);
            }

            if (content) {
                const fileId = sha256(filePath);

                const codeChunks = chunkCode(content, filePath, fileId);

                for (const chunk of codeChunks) {
                    const embedding = await generateEmbedding(chunk.content);
                    chunk.vector = embedding;
                }

                if (codeChunks.length > 0) {
                    await addCodeChunks(codeChunks);
                }

                const astNodes = await parseFile(content, filePath, fileId);

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
            debug('Error reindexing file:', filePath, err);
            errors++;
        }
    }

    console.log(`[OVCS] Reindex complete: ${processed} files processed${errors > 0 ? `, ${errors} errors` : ''}`);
    return { processed, errors };
}

function isVectorSyncInitialized() {
    return initialized;
}

export {
    initVectorSync,
    syncFileToVectorDB,
    removeFileFromVectorDB,
    indexExistingFiles,
    reindexAll,
    isVectorSyncInitialized
};
