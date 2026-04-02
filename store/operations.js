import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { debug } from "../debug.js";
import { syncFileToVectorDB, removeFileFromVectorDB } from '../vectorSync.js';
import { updateActiveFiles } from '../presence.js';
import { computeOverlaps } from '../earlyWarning.js';
import {
    getFilesCollection, getWatchBaseDirectory, getStoredMetadata,
    getRecentActiveFiles, setRecentActiveFiles, getMaxActiveFiles
} from './database.js';

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function getGitHead() {
    const storedMetadata = getStoredMetadata();
    if (!storedMetadata?.git?.inRepo) return null;
    try {
        return execSync('git rev-parse HEAD', { cwd: getWatchBaseDirectory(), stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    } catch (e) {
        return null;
    }
}

async function saveData(data, metadata) {
    const filesCollection = getFilesCollection();
    if (!filesCollection) {
        throw new Error('Database not initialized. Call initDB() first.');
    }

    // Handle delete immediately - remove from vector DB
    if (data.type === 'delete') {
        removeFileFromVectorDB(data.id).catch(err => {
            debug('Vector delete error:', err);
        });
    }

    const docId = sha256(data.id);
    const now = new Date().toISOString();

    try {
        const existing = await filesCollection.findOne(docId).exec();

        if (existing) {
            debug('existing', existing.toJSON());
            if (existing.type === data.type && existing.hash === data.hash) {
                debug('no change', data.id);
                return;
            }

            // Build updated revisions — keyed by clientId for uniqueness
            const clientKey = metadata.clientId || metadata.email;
            const revisions = existing.revisions ? JSON.parse(JSON.stringify(existing.revisions)) : {};
            const commitHash = getGitHead();
            revisions[clientKey] = {
                email: metadata.email,
                hash: data.hash,
                updated: now,
                ...(commitHash && { commitHash })
            };

            await existing.patch({
                type: data.type,
                hash: data.hash,
                revisions: revisions,
                updatedAt: Date.now()
            });

            debug('Updated document:', docId);
        } else {
            // New file - create document
            debug('new file', data.id);
            const commitHash = getGitHead();
            await filesCollection.insert({
                id: docId,
                file: data.id,
                type: data.type,
                hash: data.hash,
                revisions: {
                    [metadata.clientId || metadata.email]: {
                        email: metadata.email,
                        hash: data.hash,
                        updated: now,
                        ...(commitHash && { commitHash })
                    }
                },
                updatedAt: Date.now()
            });
        }

        // Sync to vector DB after successful update (read content from disk)
        if (data.type === 'file') {
            syncFileToVectorDB(data, metadata).catch(err => {
                debug('Vector sync error:', err);
            });
        }
    } catch (err) {
        debug('error saving data', err);
    }

    // Update presence with recently changed files
    if (data.id) {
        let recentActiveFiles = getRecentActiveFiles();
        recentActiveFiles = recentActiveFiles.filter(f => f !== data.id);
        recentActiveFiles.unshift(data.id);
        if (recentActiveFiles.length > getMaxActiveFiles()) {
            recentActiveFiles = recentActiveFiles.slice(0, getMaxActiveFiles());
        }
        setRecentActiveFiles(recentActiveFiles);
        updateActiveFiles(recentActiveFiles).catch(err => {
            debug('Presence active files update error:', err);
        });
        // Trigger immediate overlap check when local files change
        computeOverlaps();
    }
}

export { saveData, sha256, getGitHead };
