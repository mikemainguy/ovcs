import fs from "node:fs";
import { OVCSSETTINGS } from "../const.js";
import { debug } from "../debug.js";

const PERSIST_FILE = `${OVCSSETTINGS.ROOT_DIR}/rxdb-data.json`;

// Persist data to disk as JSON (since we use memory storage)
async function persistData(filesCollection) {
    if (!filesCollection) return;
    try {
        const docs = await filesCollection.find().exec();
        const data = docs.map(d => d.toJSON());
        fs.writeFileSync(PERSIST_FILE, JSON.stringify(data));
        debug(`Persisted ${data.length} docs to disk`);
    } catch (err) {
        debug('Error persisting data:', err);
    }
}

async function loadPersistedData(filesCollection) {
    if (!filesCollection) return;
    try {
        if (fs.existsSync(PERSIST_FILE)) {
            const raw = fs.readFileSync(PERSIST_FILE, 'utf-8');
            const data = JSON.parse(raw);
            if (data.length > 0) {
                await filesCollection.bulkInsert(data);
                debug(`Loaded ${data.length} docs from disk`);
            }
        }
    } catch (err) {
        debug('Error loading persisted data:', err);
    }
}

// Periodic persistence (every 30 seconds)
let persistTimer = null;
let _getFilesCollection = null;

function startPersistence(getFilesCollection) {
    if (persistTimer) return;
    _getFilesCollection = getFilesCollection;
    persistTimer = setInterval(() => persistData(getFilesCollection()), 30000);
}

function stopPersistence() {
    if (persistTimer) {
        clearInterval(persistTimer);
        persistTimer = null;
    }
    // Final persist on stop
    if (_getFilesCollection) {
        persistData(_getFilesCollection());
    }
}

export { persistData, loadPersistedData, startPersistence, stopPersistence };
