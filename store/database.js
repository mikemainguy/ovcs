import { addRxPlugin, createRxDatabase } from 'rxdb';
import { wrappedValidateAjvStorage } from 'rxdb/plugins/validate-ajv';
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory';
import { OVCSSETTINGS } from "../const.js";
import { debug } from "../debug.js";
import { fileSchema, ovcsConflictHandler } from './schema.js';
import { loadPersistedData } from './persistence.js';

if (process.env.DEBUG_OVCS) {
    const { RxDBDevModePlugin } = await import('rxdb/plugins/dev-mode');
    addRxPlugin(RxDBDevModePlugin);
}

function getStorage() {
    return wrappedValidateAjvStorage({ storage: getRxStorageMemory() });
}

// Shared state
let db = null;
let filesCollection = null;
let syncHandler = null;
let dbInitPromise = null;
let syncStatus = { state: 'disconnected', lastSync: null, error: null };
let watchBaseDirectory = '.';
let storedMetadata = null;
let scanStatus = { ready: false, fileCount: 0 };
let recentActiveFiles = [];
const MAX_ACTIVE_FILES = 20;

// Getters
function getDb() { return db; }
function getFilesCollection() { return filesCollection; }
function getSyncHandler() { return syncHandler; }
function getSyncStatus() { return syncStatus; }
function getWatchBaseDirectory() { return watchBaseDirectory; }
function getStoredMetadata() { return storedMetadata; }
function getScanStatus() { return scanStatus; }
function getRecentActiveFiles() { return recentActiveFiles; }
function getMaxActiveFiles() { return MAX_ACTIVE_FILES; }

// Setters
function setSyncHandler(handler) { syncHandler = handler; }
function setSyncStatus(status) { syncStatus = status; }
function setWatchBaseDirectory(dir) { watchBaseDirectory = dir; }
function setStoredMetadata(meta) { storedMetadata = meta; }
function setScanStatus(ready, fileCount) { scanStatus = { ready, fileCount }; }
function setRecentActiveFiles(files) { recentActiveFiles = files; }

// Initialize database once - must be called before any other db operations
async function initDB() {
    if (db) return db;
    if (dbInitPromise) return dbInitPromise;

    dbInitPromise = (async () => {
        db = await createRxDatabase({
            name: `${OVCSSETTINGS.ROOT_DIR}/localdb`,
            storage: getStorage(),
            multiInstance: false
        });

        await db.addCollections({
            files: {
                schema: fileSchema,
                conflictHandler: ovcsConflictHandler
            }
        });

        filesCollection = db.files;

        // Load persisted data if it exists
        await loadPersistedData(filesCollection);

        const docs = await filesCollection.find().exec();
        debug(`Database initialized: localdb (${docs.length} docs)`);
        return db;
    })();

    return dbInitPromise;
}

export {
    initDB, getStorage,
    getDb, getFilesCollection, getSyncHandler, getSyncStatus,
    getWatchBaseDirectory, getStoredMetadata, getScanStatus,
    getRecentActiveFiles, getMaxActiveFiles,
    setSyncHandler, setSyncStatus, setWatchBaseDirectory,
    setStoredMetadata, setScanStatus, setRecentActiveFiles
};
