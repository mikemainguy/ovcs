import { initVectorStore, addCodeChunks, addAstNodes, addCallEdges, removeCallEdges, loadAllCallEdges, removeFileVectors, clearAllVectors, isInitialized, getStats } from './vectorStore.js';
import { initEmbeddings, generateEmbedding, isModelLoaded } from './embeddings.js';
import { chunkCode, isSupportedFile, sha256 } from './chunker.js';
import { parseFile, parseFileWithCallGraph, createSearchableText } from './astParser.js';
import { callGraph } from './callGraph.js';
import { OVCSSETTINGS } from './const.js';
import { debug } from './debug.js';
import fs from 'node:fs';
import * as path from 'node:path';

let pwd = null;
let syncQueue = [];
let isProcessing = false;
let initialized = false;

let ignoreDirs = new Set();

async function initVectorSync(workingDir, ignorePatterns = []) {
    pwd = workingDir;
    ignoreDirs = new Set(ignorePatterns);

    try {
        await initVectorStore(pwd);
        await initEmbeddings(pwd);
        initialized = true;

        // Load call graph from persisted edges
        await loadCallGraphFromDB();

        const stats = await getStats();
        const graphStats = callGraph.getStats();
        console.log(`[OVCS] Search engine ready (${stats.code_chunks} chunks, ${stats.ast_nodes} AST nodes, ${graphStats.edges} call edges in index)`);
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
    await removeCallEdges(fileId);
    callGraph.removeEdgesForFile(fileId);

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

    // Parse file with call graph support
    const { astNodes, callEdges } = await parseFileWithCallGraph(
        content, filePath, fileId, pwd, resolveSymbolInIndex
    );

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

    // Register AST nodes in the call graph
    for (const node of astNodes) {
        if (node.node_type === 'function' || node.node_type === 'class') {
            callGraph.addNode(node.id, node.node_name, node.file_path, node.node_type);
        }
    }

    // Generate embeddings for call edges and persist
    for (const edge of callEdges) {
        try {
            const edgeText = `${edge.caller_name} calls ${edge.callee_name}`;
            edge.vector = await generateEmbedding(edgeText);
        } catch (err) {
            debug('Error generating embedding for call edge:', err);
            edge.vector = new Array(384).fill(0);
        }
    }

    if (callEdges.length > 0) {
        await addCallEdges(callEdges);

        // Update in-memory graph
        for (const edge of callEdges) {
            callGraph.addEdge(edge.id, edge.caller_id, edge.callee_id, edge.file_id, {
                callerName: edge.caller_name,
                calleeName: edge.callee_name,
                callLine: edge.call_line,
                callType: edge.call_type,
                resolved: edge.resolved === 1
            });
            // Register unresolved callees so they show human-readable names
            if (edge.resolved === 0 && edge.callee_name) {
                callGraph.addNode(edge.callee_id, edge.callee_name, edge.callee_file || '', 'external', edge.source_module || '');
            }
        }
    }

    debug(`Synced file to vector DB: ${filePath} (${codeChunks.length} chunks, ${astNodes.length} AST nodes, ${callEdges.length} call edges)`);
}

async function loadCallGraphFromDB() {
    try {
        const edges = await loadAllCallEdges();
        if (edges.length === 0) {
            debug('No call edges to load into graph');
            return;
        }

        callGraph.clear();
        for (const edge of edges) {
            callGraph.addEdge(edge.id, edge.caller_id, edge.callee_id, edge.file_id, {
                callerName: edge.caller_name,
                calleeName: edge.callee_name,
                callLine: edge.call_line,
                callType: edge.call_type,
                resolved: edge.resolved === 1
            });
            // Add node info for both caller and callee
            if (edge.caller_name) {
                callGraph.addNode(edge.caller_id, edge.caller_name, edge.caller_file, 'function');
            }
            if (edge.callee_name) {
                callGraph.addNode(edge.callee_id, edge.callee_name, edge.callee_file || '', edge.resolved === 1 ? 'function' : 'external', edge.source_module || '');
            }
        }

        const stats = callGraph.getStats();
        debug(`Loaded call graph: ${stats.nodes} nodes, ${stats.edges} edges`);
    } catch (err) {
        debug('Error loading call graph from DB:', err);
    }
}

/**
 * Resolve a symbol name within the existing AST index.
 * Used for cross-file call resolution during edge building.
 */
async function resolveSymbolInIndex(name, sourceFile) {
    if (!sourceFile) return null;

    try {
        // Generate embedding for the function name and search AST nodes
        const queryVector = await generateEmbedding(name);
        const { searchAstNodes } = await import('./vectorStore.js');
        const results = await searchAstNodes(queryVector, 20, 'function');

        // Find an exact name match in the target file
        for (const r of results) {
            if (r.node_name === name && r.file_path === sourceFile) {
                return { id: r.id, name: r.node_name, file_path: r.file_path };
            }
        }

        // Fall back to exact name match in any file if source file doesn't match
        for (const r of results) {
            if (r.node_name === name) {
                return { id: r.id, name: r.node_name, file_path: r.file_path };
            }
        }
    } catch (err) {
        debug('Error resolving symbol:', name, err.message);
    }

    return null;
}

async function processFileDelete(fileId) {
    const hashedId = sha256(fileId);
    await removeFileVectors(hashedId);
    await removeCallEdges(hashedId);
    callGraph.removeEdgesForFile(hashedId);
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
        if (ignoreDirs.has(entry.name)) continue;

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
    callGraph.clear();

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
    isVectorSyncInitialized,
    callGraph
};
