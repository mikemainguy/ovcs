import { replicateServer } from 'rxdb-server/plugins/replication-server';
import { debug } from "../debug.js";
import { getPresenceCollection } from '../presence.js';
import { initP2P } from '../p2p.js';
import {
    getFilesCollection, getSyncHandler, getStoredMetadata, getWatchBaseDirectory,
    getSyncStatus, setSyncHandler, setSyncStatus
} from './database.js';
import { reconcileFilesystem, cleanupRevisions, startReconciliationTimer, onRemoteDocChange } from './reconciliation.js';

// Start replication — called AFTER chokidar initial scan completes
async function startReplication(options = {}) {
    const metadata = getStoredMetadata();
    if (!metadata) return;
    const watchBaseDirectory = getWatchBaseDirectory();

    // Reconcile DB against filesystem now that scan is done
    await reconcileFilesystem(metadata, watchBaseDirectory);

    // Clean up stale revisions on startup (before replication sends stale data)
    await cleanupRevisions(metadata);

    // Start P2P or server replication
    if (options.p2p && metadata.teamId) {
        const signalingUrl = metadata.p2p?.signalingServer || metadata.remote?.replace(/^https/, 'wss').replace(/^http/, 'ws').replace(/\/[^/]*$/, '/signaling');
        if (signalingUrl) {
            try {
                await initP2P({
                    filesCollection: getFilesCollection(),
                    presenceCollection: getPresenceCollection(),
                    signalingServerUrl: signalingUrl,
                    teamId: metadata.teamId,
                    baseDirectory: watchBaseDirectory,
                    iceServers: metadata.p2p?.iceServers || [],
                    metadata
                });
                debug('P2P replication initialized');
            } catch (err) {
                debug('Error initializing P2P replication:', err);
            }
        } else {
            console.error('P2P mode requires a signaling server URL (set p2p.signalingServer in ovcs.json or provide remote URL)');
        }
    } else if (metadata.sync?.enabled && metadata.remote) {
        try {
            await initRemoteSync(metadata);
            debug('Remote sync initialized');
        } catch (err) {
            debug('Error initializing remote sync:', err);
        }
    }

    // Start periodic reconciliation timer (safety net)
    startReconciliationTimer(metadata, watchBaseDirectory);
    debug('Replication started');
}

async function initRemoteSync(metadata, retryCount = 0) {
    const MAX_RETRIES = 5;
    const RETRY_DELAY = Math.pow(2, retryCount) * 1000;

    if (!metadata.remote || !metadata.sync?.enabled) {
        debug('Remote sync disabled or no remote configured');
        return;
    }

    const filesCollection = getFilesCollection();
    if (!filesCollection) {
        throw new Error('Database not initialized. Call initDB() first.');
    }

    const syncStatus = getSyncStatus();
    syncStatus.state = 'connecting';
    syncStatus.error = null;

    // Derive server base URL from metadata.remote
    // metadata.remote is like "http://localhost:5984/ovcs" — use the base URL
    const serverUrl = metadata.remote.replace(/\/[^/]*$/, '');
    debug(`Connecting to remote: ${serverUrl}`);

    try {
        // Test connection
        const response = await fetch(`${serverUrl}/ovcs/status`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = await response.json();
        debug(`Remote server connected: ${status.status}`);
    } catch (err) {
        if (retryCount < MAX_RETRIES) {
            debug(`Connection failed, retrying in ${RETRY_DELAY/1000}s... (${retryCount + 1}/${MAX_RETRIES})`);
            syncStatus.state = 'connecting';
            syncStatus.error = `Retry ${retryCount + 1}/${MAX_RETRIES}: ${err.message}`;
            setTimeout(() => initRemoteSync(metadata, retryCount + 1), RETRY_DELAY);
            return;
        }
        console.error(`Failed to connect after ${MAX_RETRIES} attempts: ${err.message}`);
        syncStatus.state = 'error';
        syncStatus.error = `Failed after ${MAX_RETRIES} attempts: ${err.message}`;
        return;
    }

    // Start RxDB server replication for files
    const replicationUrl = `${serverUrl}/replication/files/0`;
    debug(`Replication URL: ${replicationUrl}`);
    try {
        const handler = replicateServer({
            collection: filesCollection,
            replicationIdentifier: 'ovcs-files-sync',
            url: replicationUrl,
            live: metadata.sync.live !== false,
            push: {},
            pull: {}
        });
        setSyncHandler(handler);

        handler.error$.subscribe(err => {
            console.error('Sync error:', JSON.stringify({
                message: err.message,
                direction: err.direction,
                code: err.code,
                errors: err.innerErrors ? err.innerErrors.map(e => ({ name: e.name, message: e.message?.substring(0, 200) })) : undefined
            }, null, 2));
            syncStatus.state = 'error';
            syncStatus.error = err.message || String(err);
        });

        handler.active$.subscribe(active => {
            if (active) {
                syncStatus.state = 'syncing';
                debug('Sync active');
            } else {
                syncStatus.state = 'synced';
                syncStatus.lastSync = new Date().toISOString();
                syncStatus.error = null;
                debug('Sync paused (up to date)');
            }
        });

        // Listen for incoming remote docs and add local revision
        filesCollection.$.subscribe(changeEvent => onRemoteDocChange(changeEvent));

        debug('RxDB server replication started');
    } catch (err) {
        console.error('Error starting replication:', err);
        syncStatus.state = 'error';
        syncStatus.error = err.message;
    }
}

function stopRemoteSync() {
    const handler = getSyncHandler();
    if (handler) {
        handler.cancel();
        setSyncHandler(null);
        debug('Remote sync stopped');
    }
}

// Conflict resolution is now handled by RxDB's conflictHandler on the schema
async function resolveConflicts() {
    // No-op: RxDB handles conflicts via the conflictHandler defined on the collection
    debug('Conflict resolution is handled by RxDB conflictHandler');
}

export { startReplication, initRemoteSync, stopRemoteSync, resolveConflicts };
