import { searchCodeChunks, searchAstNodes, searchFunctions, findSimilarFiles, getStats, isInitialized } from './vectorStore.js';
import { generateEmbedding, isModelLoaded } from './embeddings.js';
import { reindexAll, isVectorSyncInitialized } from './vectorSync.js';
import { sha256 } from './chunker.js';
import { debug } from './debug.js';

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

            let content = '';
            if (targetDoc.doc.base64) {
                content = Buffer.from(targetDoc.doc.base64, 'base64').toString('utf-8');
            } else if (targetDoc.doc.revisions) {
                const revisionKeys = Object.keys(targetDoc.doc.revisions);
                if (revisionKeys.length > 0) {
                    const latestRevision = targetDoc.doc.revisions[revisionKeys[0]];
                    if (latestRevision.content) {
                        content = Buffer.from(latestRevision.content, 'base64').toString('utf-8');
                    }
                }
            }

            if (!content) {
                return res.status(400).json({ error: 'File has no content' });
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
