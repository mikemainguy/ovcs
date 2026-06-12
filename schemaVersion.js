import fs from 'node:fs';
import path from 'node:path';
import { OVCSSETTINGS, VECTOR_SCHEMA_VERSION, RXDB_SCHEMA_VERSION } from './const.js';
import { debug } from './debug.js';

const STATE_FILE = 'schema-state.json';

function getStatePath(pwd) {
    return path.join(pwd, OVCSSETTINGS.ROOT_DIR, STATE_FILE);
}

function readSchemaState(pwd) {
    const statePath = getStatePath(pwd);
    try {
        if (fs.existsSync(statePath)) {
            return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        }
    } catch (err) {
        debug('Error reading schema state:', err.message);
    }
    // No state file = first run or pre-versioning install
    return null;
}

function writeSchemaState(pwd) {
    const statePath = getStatePath(pwd);
    const state = {
        vectorSchemaVersion: VECTOR_SCHEMA_VERSION,
        rxdbSchemaVersion: RXDB_SCHEMA_VERSION,
        updatedAt: new Date().toISOString()
    };
    try {
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        debug('Schema state written:', state);
    } catch (err) {
        debug('Error writing schema state:', err.message);
    }
}

/**
 * Check current code schema versions against what's stored on disk.
 * Returns an object describing what needs upgrading.
 */
function checkSchemaVersions(pwd) {
    const stored = readSchemaState(pwd);

    const result = {
        needsVectorReindex: false,
        needsRxdbRebuild: false,
        isFirstRun: false,
        storedVectorVersion: null,
        storedRxdbVersion: null,
        currentVectorVersion: VECTOR_SCHEMA_VERSION,
        currentRxdbVersion: RXDB_SCHEMA_VERSION
    };

    if (!stored) {
        // No state file: either first run or pre-versioning install
        // Check if .ovcs/vectordb exists to distinguish
        const vectorDbPath = path.join(pwd, OVCSSETTINGS.ROOT_DIR, OVCSSETTINGS.VECTOR_DB_DIR);
        const rxdbDataPath = path.join(pwd, OVCSSETTINGS.ROOT_DIR, 'rxdb-data.json');
        const hasExistingData = fs.existsSync(vectorDbPath) || fs.existsSync(rxdbDataPath);

        if (hasExistingData) {
            // Pre-versioning install: treat as version 0 for both
            result.storedVectorVersion = 0;
            result.storedRxdbVersion = 0;
            result.needsVectorReindex = VECTOR_SCHEMA_VERSION > 0;
            result.needsRxdbRebuild = RXDB_SCHEMA_VERSION > 0;
        } else {
            result.isFirstRun = true;
        }
        return result;
    }

    result.storedVectorVersion = stored.vectorSchemaVersion ?? 0;
    result.storedRxdbVersion = stored.rxdbSchemaVersion ?? 0;
    result.needsVectorReindex = result.storedVectorVersion < VECTOR_SCHEMA_VERSION;
    result.needsRxdbRebuild = result.storedRxdbVersion < RXDB_SCHEMA_VERSION;

    return result;
}

/**
 * Clear vector DB data (LanceDB tables) for a clean reindex.
 */
function clearVectorData(pwd) {
    const vectorDbPath = path.join(pwd, OVCSSETTINGS.ROOT_DIR, OVCSSETTINGS.VECTOR_DB_DIR);
    if (fs.existsSync(vectorDbPath)) {
        fs.rmSync(vectorDbPath, { recursive: true, force: true });
        debug('Cleared vector DB directory for reindex');
    }
}

/**
 * Clear RxDB persisted data for a clean rebuild.
 */
function clearRxdbData(pwd) {
    const rxdbDataPath = path.join(pwd, OVCSSETTINGS.ROOT_DIR, 'rxdb-data.json');
    const presencePath = path.join(pwd, OVCSSETTINGS.ROOT_DIR, 'rxdb-presence.json');
    if (fs.existsSync(rxdbDataPath)) {
        fs.unlinkSync(rxdbDataPath);
        debug('Cleared RxDB data file');
    }
    if (fs.existsSync(presencePath)) {
        fs.unlinkSync(presencePath);
        debug('Cleared RxDB presence file');
    }
}

export {
    checkSchemaVersions,
    writeSchemaState,
    clearVectorData,
    clearRxdbData,
    VECTOR_SCHEMA_VERSION,
    RXDB_SCHEMA_VERSION
};
