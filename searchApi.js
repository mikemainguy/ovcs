import { searchCodeChunks, searchAstNodes, searchFunctions, findSimilarFiles, getStats, isInitialized } from './vectorStore.js';
import { generateEmbedding, isModelLoaded } from './embeddings.js';
import { reindexAll, isVectorSyncInitialized } from './vectorSync.js';
import { sha256 } from './chunker.js';
import { OVCSSETTINGS } from './const.js';
import { debug } from './debug.js';
import fs from 'node:fs';
import * as path from 'node:path';

function setupSearchRoutes(app, db) {
    app.get('/search', async (req, res) => {
        try {
            const { q: query, type = 'code', limit = 10 } = req.query;

            if (!query) {
                return res.status(400).json({ error: 'Query parameter "q" is required' });
            }

            if (!isVectorSyncInitialized()) {
                return res.status(503).json({ error: 'Vector search is not initialized' });
            }

            const queryVector = await generateEmbedding(query);
            const limitNum = parseInt(limit, 10);

            let results;
            if (type === 'ast' || type === 'nodes') {
                results = await searchAstNodes(queryVector, limitNum);
            } else {
                results = await searchCodeChunks(queryVector, limitNum);
            }

            const formattedResults = results.map(r => ({
                file_path: r.file_path,
                file_id: r.file_id,
                content: r.content,
                start_line: r.start_line,
                end_line: r.end_line,
                language: r.language,
                score: r._distance ? 1 - r._distance : null,
                ...(type === 'ast' || type === 'nodes' ? {
                    node_type: r.node_type,
                    node_name: r.node_name,
                    signature: r.signature
                } : {
                    chunk_index: r.chunk_index
                })
            }));

            res.json({
                query,
                type,
                count: formattedResults.length,
                results: formattedResults
            });
        } catch (err) {
            debug('Search error:', err);
            res.status(500).json({ error: 'Search failed', message: err.message });
        }
    });

    app.get('/search/functions', async (req, res) => {
        try {
            const { q: query, limit = 10 } = req.query;

            if (!query) {
                return res.status(400).json({ error: 'Query parameter "q" is required' });
            }

            if (!isVectorSyncInitialized()) {
                return res.status(503).json({ error: 'Vector search is not initialized' });
            }

            const queryVector = await generateEmbedding(query);
            const limitNum = parseInt(limit, 10);

            const results = await searchFunctions(queryVector, limitNum);

            const formattedResults = results.map(r => ({
                file_path: r.file_path,
                file_id: r.file_id,
                node_name: r.node_name,
                signature: r.signature,
                start_line: r.start_line,
                end_line: r.end_line,
                language: r.language,
                dependencies: r.dependencies ? r.dependencies.split(',') : [],
                score: r._distance ? 1 - r._distance : null
            }));

            res.json({
                query,
                count: formattedResults.length,
                results: formattedResults
            });
        } catch (err) {
            debug('Function search error:', err);
            res.status(500).json({ error: 'Function search failed', message: err.message });
        }
    });

    app.get('/search/similar/:fileId', async (req, res) => {
        try {
            const { fileId } = req.params;
            const { limit = 10 } = req.query;

            if (!isVectorSyncInitialized()) {
                return res.status(503).json({ error: 'Vector search is not initialized' });
            }

            const hashedFileId = sha256(fileId);

            const fileDoc = await db.allDocs({ include_docs: true });
            const targetDoc = fileDoc.rows.find(row =>
                row.doc.file === fileId || row.id === hashedFileId
            );

            if (!targetDoc) {
                return res.status(404).json({ error: 'File not found' });
            }

            // Read content from disk
            let content = '';
            if (targetDoc.doc.file) {
                try {
                    const filePath = path.resolve('.', targetDoc.doc.file);
                    if (fs.existsSync(filePath)) {
                        content = fs.readFileSync(filePath, 'utf-8');
                    }
                } catch (err) {
                    debug('Error reading file for search:', targetDoc.doc.file, err.message);
                }
            }

            if (!content) {
                return res.status(400).json({ error: 'File content not available on disk' });
            }

            const queryVector = await generateEmbedding(content.substring(0, 2000));
            const limitNum = parseInt(limit, 10);

            const results = await findSimilarFiles(hashedFileId, queryVector, limitNum);

            const formattedResults = results.map(r => ({
                file_path: r.file_path,
                file_id: r.file_id,
                language: r.language,
                score: r._distance ? 1 - r._distance : null
            }));

            res.json({
                source_file: fileId,
                count: formattedResults.length,
                similar_files: formattedResults
            });
        } catch (err) {
            debug('Similar files search error:', err);
            res.status(500).json({ error: 'Similar files search failed', message: err.message });
        }
    });

    app.get('/search/stats', async (req, res) => {
        try {
            const stats = await getStats();

            res.json({
                initialized: isVectorSyncInitialized(),
                model_loaded: isModelLoaded(),
                vector_db_initialized: isInitialized(),
                supported_extensions: Object.keys(OVCSSETTINGS.LANGUAGE_MAP),
                ...stats
            });
        } catch (err) {
            debug('Stats error:', err);
            res.status(500).json({ error: 'Failed to get stats', message: err.message });
        }
    });

    app.post('/search/reindex', async (req, res) => {
        try {
            if (!isVectorSyncInitialized()) {
                return res.status(503).json({ error: 'Vector search is not initialized' });
            }

            const result = await reindexAll(db);

            res.json({
                message: 'Reindex complete',
                ...result
            });
        } catch (err) {
            debug('Reindex error:', err);
            res.status(500).json({ error: 'Reindex failed', message: err.message });
        }
    });

    debug('Search API routes configured');
}

export { setupSearchRoutes };
