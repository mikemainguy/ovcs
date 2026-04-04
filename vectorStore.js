import lancedb from '@lancedb/lancedb';
import { OVCSSETTINGS } from './const.js';
import { debug } from './debug.js';
import path from 'node:path';
import fs from 'node:fs';

let db = null;
let codeChunksTable = null;
let astNodesTable = null;

const CODE_CHUNKS_TABLE = 'code_chunks';
const AST_NODES_TABLE = 'ast_nodes';

async function initVectorStore(pwd) {
    const vectorDbPath = path.join(pwd, OVCSSETTINGS.ROOT_DIR, OVCSSETTINGS.VECTOR_DB_DIR);

    if (!fs.existsSync(vectorDbPath)) {
        fs.mkdirSync(vectorDbPath, { recursive: true });
    }

    db = await lancedb.connect(vectorDbPath);
    debug('Vector store initialized at:', vectorDbPath);

    await ensureTables();
    return db;
}

async function ensureTables() {
    const tables = await db.tableNames();

    if (!tables.includes(CODE_CHUNKS_TABLE)) {
        const emptyCodeChunk = {
            id: '_init_',
            file_path: '',
            file_id: '',
            chunk_index: 0,
            content: '',
            start_line: 0,
            end_line: 0,
            language: '',
            vector: new Array(OVCSSETTINGS.EMBEDDING_DIMENSIONS).fill(0),
            updated_at: new Date().toISOString(),
            content_hash: ''
        };
        codeChunksTable = await db.createTable(CODE_CHUNKS_TABLE, [emptyCodeChunk]);
        await codeChunksTable.delete('id = "_init_"');
        debug('Created code_chunks table');
    } else {
        codeChunksTable = await db.openTable(CODE_CHUNKS_TABLE);
    }

    if (!tables.includes(AST_NODES_TABLE)) {
        const emptyAstNode = {
            id: '_init_',
            file_path: '',
            file_id: '',
            node_type: '',
            node_name: '',
            parent_id: '',
            start_line: 0,
            end_line: 0,
            language: '',
            signature: '',
            dependencies: '',
            vector: new Array(OVCSSETTINGS.EMBEDDING_DIMENSIONS).fill(0),
            updated_at: new Date().toISOString()
        };
        astNodesTable = await db.createTable(AST_NODES_TABLE, [emptyAstNode]);
        await astNodesTable.delete('id = "_init_"');
        debug('Created ast_nodes table');
    } else {
        astNodesTable = await db.openTable(AST_NODES_TABLE);
    }
}

async function addCodeChunks(chunks) {
    if (!codeChunksTable || chunks.length === 0) return;
    await codeChunksTable.add(chunks);
    debug(`Added ${chunks.length} code chunks`);
}

async function addAstNodes(nodes) {
    if (!astNodesTable || nodes.length === 0) return;
    await astNodesTable.add(nodes);
    debug(`Added ${nodes.length} AST nodes`);
}

async function removeFileVectors(fileId) {
    if (!codeChunksTable || !astNodesTable) return;

    try {
        await codeChunksTable.delete(`file_id = "${fileId}"`);
        await astNodesTable.delete(`file_id = "${fileId}"`);
        debug(`Removed vectors for file: ${fileId}`);
    } catch (err) {
        debug('Error removing file vectors:', err);
    }
}

async function searchCodeChunks(queryVector, limit = 10) {
    if (!codeChunksTable) return [];

    try {
        const results = await codeChunksTable
            .vectorSearch(queryVector)
            .limit(limit)
            .toArray();
        return results;
    } catch (err) {
        debug('Error searching code chunks:', err);
        return [];
    }
}

async function searchAstNodes(queryVector, limit = 10, nodeType = null) {
    if (!astNodesTable) return [];

    try {
        let query = astNodesTable.vectorSearch(queryVector).limit(limit);
        if (nodeType) {
            query = query.where(`node_type = "${nodeType}"`);
        }
        const results = await query.toArray();
        return results;
    } catch (err) {
        debug('Error searching AST nodes:', err);
        return [];
    }
}

async function searchFunctions(queryVector, limit = 10) {
    return searchAstNodes(queryVector, limit, 'function');
}

async function findSimilarFiles(fileId, queryVector, limit = 10) {
    if (!codeChunksTable) return [];

    try {
        const results = await codeChunksTable
            .vectorSearch(queryVector)
            .where(`file_id != "${fileId}"`)
            .limit(limit)
            .toArray();

        const uniqueFiles = [];
        const seenFiles = new Set();
        for (const result of results) {
            if (!seenFiles.has(result.file_id)) {
                seenFiles.add(result.file_id);
                uniqueFiles.push(result);
            }
        }
        return uniqueFiles;
    } catch (err) {
        debug('Error finding similar files:', err);
        return [];
    }
}

async function getStats() {
    const stats = {
        code_chunks: 0,
        ast_nodes: 0,
        tables: []
    };

    if (db) {
        stats.tables = await db.tableNames();
    }

    if (codeChunksTable) {
        const countResult = await codeChunksTable.countRows();
        stats.code_chunks = countResult;
    }

    if (astNodesTable) {
        const countResult = await astNodesTable.countRows();
        stats.ast_nodes = countResult;
    }

    return stats;
}

async function clearAllVectors() {
    if (codeChunksTable) {
        await codeChunksTable.delete('id IS NOT NULL');
    }
    if (astNodesTable) {
        await astNodesTable.delete('id IS NOT NULL');
    }
    debug('Cleared all vectors');
}

function isInitialized() {
    return db !== null;
}

export {
    initVectorStore,
    addCodeChunks,
    addAstNodes,
    removeFileVectors,
    searchCodeChunks,
    searchAstNodes,
    searchFunctions,
    findSimilarFiles,
    getStats,
    clearAllVectors,
    isInitialized
};
