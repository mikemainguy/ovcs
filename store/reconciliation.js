import fs from "node:fs";
import * as path from "node:path";
import { OVCSSETTINGS } from "../const.js";
import { debug } from "../debug.js";
import { getPresenceCollection } from '../presence.js';
import { getFilesCollection, getStoredMetadata, getWatchBaseDirectory } from './database.js';
import { sha256, getGitHead } from './operations.js';

let reconcileTimer = null;

// Reconcile DB state against the local filesystem.
// For every file doc, ensures this client has a revision reflecting current disk state.
// Never mutates doc.type or doc.hash — only updates the local client's revision entry.
async function reconcileFilesystem(metadata, baseDirectory) {
    const filesCollection = getFilesCollection();
    if (!filesCollection) return;
    const docs = await filesCollection.find().exec();
    let updated = 0, unchanged = 0;
    const clientKey = metadata.clientId || metadata.email;

    for (const doc of docs) {
        const d = doc.toJSON();
        if (!d.file || d.type === 'dir') continue;

        // Compute current local disk state
        const filePath = path.resolve(baseDirectory, d.file);
        let localHash = '';
        if (fs.existsSync(filePath)) {
            try {
                const content = fs.readFileSync(filePath);
                localHash = sha256(content);
            } catch (err) {
                debug('Reconcile read error:', d.file, err.message);
                continue;
            }
        }

        // Skip if our revision already matches
        if (d.revisions?.[clientKey]?.hash === localHash) {
            unchanged++;
            continue;
        }

        // Update only our revision entry
        const commitHash = getGitHead();
        const revisions = d.revisions ? JSON.parse(JSON.stringify(d.revisions)) : {};
        revisions[clientKey] = {
            email: metadata.email,
            hash: localHash,
            updated: new Date().toISOString(),
            ...(commitHash && { commitHash })
        };
        await doc.patch({
            revisions,
            updatedAt: Date.now()
        });
        updated++;
    }
    debug(`Reconciliation: ${updated} updated, ${unchanged} unchanged (${docs.length} total)`);
}

// Handle incoming remote doc changes — add local revision showing current disk state
async function onRemoteDocChange(changeEvent) {
    if (changeEvent.isLocal) return;
    const storedMetadata = getStoredMetadata();
    const filesCollection = getFilesCollection();
    if (!storedMetadata || !filesCollection) return;

    const docData = changeEvent.documentData;
    if (!docData?.file || docData.type === 'dir') return;

    const clientKey = storedMetadata.clientId || storedMetadata.email;

    // Compute current local state
    const filePath = path.resolve(getWatchBaseDirectory(), docData.file);
    let localHash = '';
    if (fs.existsSync(filePath)) {
        try {
            const content = fs.readFileSync(filePath);
            localHash = sha256(content);
        } catch (err) {
            debug('[Reconcile] Error reading file:', docData.file, err.message);
            return;
        }
    }

    // If our revision already matches current disk hash, skip (prevents replication loops)
    if (docData.revisions?.[clientKey]?.hash === localHash) {
        return;
    }

    const doc = await filesCollection.findOne(docData.id).exec();
    if (!doc) return;

    // Deep-copy to strip RxDB proxy objects (avoids structured clone errors)
    const commitHash = getGitHead();
    const revisions = doc.revisions ? JSON.parse(JSON.stringify(doc.revisions)) : {};
    revisions[clientKey] = {
        email: storedMetadata.email,
        hash: localHash,
        updated: new Date().toISOString(),
        ...(commitHash && { commitHash })
    };

    await doc.patch({
        revisions,
        updatedAt: Date.now()
    });
    debug(`[Reconcile] Added local revision for ${docData.file} (local: ${localHash.substring(0, 8) || 'missing'})`);
}

// Clean up stale revisions across all file documents.
// Uses a two-tier approach:
//   - Tier 1 (immediate, in /diff): disconnected nodes are hidden from the UI
//   - Tier 2 (deferred, here): revisions from nodes offline > REVISION_TTL are deleted
// Also removes ghost documents where all remaining revision hashes are empty.
async function cleanupRevisions(metadata) {
    const filesCollection = getFilesCollection();
    if (!filesCollection) return;
    const clientKey = metadata.clientId || metadata.email;
    const revisionTTL = OVCSSETTINGS.REVISION_TTL;

    // Build a map of clientId -> lastSeen from all presence records (active + offline).
    // Revision keys are raw clientId UUIDs; presence now stores clientId too.
    const presenceCollection = getPresenceCollection();
    const clientIdLastSeen = new Map(); // clientId -> lastSeen Date
    clientIdLastSeen.set(clientKey, new Date()); // Always keep our own

    if (presenceCollection) {
        const allPresenceDocs = await presenceCollection.find().exec();
        for (const pdoc of allPresenceDocs) {
            const p = pdoc.toJSON();
            if (p.clientId) {
                const lastSeen = p.lastSeen ? new Date(p.lastSeen) : new Date(0);
                clientIdLastSeen.set(p.clientId, lastSeen);
            }
        }
    }

    const now = Date.now();
    const docs = await filesCollection.find().exec();
    let pruned = 0, removed = 0;

    for (const doc of docs) {
        const d = doc.toJSON();
        if (!d.revisions) continue;

        const revKeys = Object.keys(d.revisions);
        if (revKeys.length === 0) continue;

        // Prune revisions from nodes whose clientId hasn't been seen within REVISION_TTL
        const revisions = JSON.parse(JSON.stringify(d.revisions));
        let changed = false;
        for (const key of revKeys) {
            if (key === clientKey) continue; // Never prune our own

            const lastSeen = clientIdLastSeen.get(key);
            if (!lastSeen || (now - lastSeen.getTime()) > revisionTTL) {
                delete revisions[key];
                changed = true;
                pruned++;
            }
        }

        // Remove ghost documents where all remaining revisions have empty hashes
        const remainingKeys = Object.keys(revisions);
        const allEmpty = remainingKeys.length === 0 ||
            remainingKeys.every(k => !revisions[k].hash || revisions[k].hash === '');

        if (allEmpty) {
            await doc.remove();
            removed++;
            continue;
        }

        if (changed) {
            await doc.patch({ revisions, updatedAt: Date.now() });
        }
    }

    if (pruned > 0 || removed > 0) {
        debug(`Revision cleanup: ${pruned} stale revisions pruned, ${removed} ghost documents removed`);
    }
}

// After a successful merge or pull, collapse all revisions to a single current hash.
// This clears the conflict state since everyone now has the same content.
async function collapseRevisionsAfterResolve(fileId) {
    const filesCollection = getFilesCollection();
    const storedMetadata = getStoredMetadata();
    if (!filesCollection || !storedMetadata) return;
    const doc = await filesCollection.findOne(fileId).exec();
    if (!doc) return;

    const d = doc.toJSON();
    if (!d.file) return;

    // Read current disk state as the canonical hash
    const filePath = path.resolve(getWatchBaseDirectory(), d.file);
    let currentHash = '';
    if (fs.existsSync(filePath)) {
        try {
            const content = fs.readFileSync(filePath);
            currentHash = sha256(content);
        } catch (err) {
            debug('[Cleanup] Error reading file after resolve:', err.message);
            return;
        }
    }

    // Update only our own revision — other nodes will self-correct via
    // onRemoteDocChange or their own reconciliation cycle
    const clientKey = storedMetadata.clientId || storedMetadata.email;
    const now = new Date().toISOString();
    const commitHash = getGitHead();
    const revisions = d.revisions ? JSON.parse(JSON.stringify(d.revisions)) : {};
    revisions[clientKey] = {
        email: storedMetadata.email,
        hash: currentHash,
        updated: now,
        ...(commitHash && { commitHash })
    };

    await doc.patch({
        hash: currentHash,
        revisions,
        updatedAt: Date.now()
    });
    debug(`[Cleanup] Updated local revision for ${d.file} to hash ${currentHash.substring(0, 8)}`);
}

// Periodic reconciliation — safety net for missed chokidar events
function startReconciliationTimer(metadata, baseDirectory) {
    if (reconcileTimer) return;
    reconcileTimer = setInterval(async () => {
        try {
            await reconcileFilesystem(metadata, baseDirectory);
            await cleanupRevisions(metadata);
        } catch (err) {
            debug('Periodic reconciliation error:', err);
        }
    }, OVCSSETTINGS.RECONCILE_INTERVAL);
}

function stopReconciliationTimer() {
    if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
    }
}

export {
    reconcileFilesystem, onRemoteDocChange, cleanupRevisions,
    collapseRevisionsAfterResolve, startReconciliationTimer, stopReconciliationTimer
};
