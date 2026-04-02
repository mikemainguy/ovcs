import fs from "node:fs";
import { DATA_DIR } from "./database.js";
import { debug } from "../debug.js";

const PERSIST_FILES = `${DATA_DIR}/rxdb-files.json`;
const PERSIST_PRESENCE = `${DATA_DIR}/rxdb-presence.json`;

async function loadPersistedData(db) {
    try {
        if (fs.existsSync(PERSIST_FILES)) {
            const data = JSON.parse(fs.readFileSync(PERSIST_FILES, 'utf-8'));
            if (data.length > 0) await db.files.bulkInsert(data);
            debug(`Loaded ${data.length} file docs from disk`);
        }
        if (fs.existsSync(PERSIST_PRESENCE)) {
            const data = JSON.parse(fs.readFileSync(PERSIST_PRESENCE, 'utf-8'));
            if (data.length > 0) await db.presence.bulkInsert(data);
            debug(`Loaded ${data.length} presence docs from disk`);
        }
    } catch (err) {
        debug('No persisted data found, starting fresh');
    }
}

function startPersistence(db) {
    const interval = setInterval(async () => {
        try {
            const fileDocs = await db.files.find().exec();
            fs.writeFileSync(PERSIST_FILES, JSON.stringify(fileDocs.map(d => d.toJSON())));
            const presenceDocs = await db.presence.find().exec();
            fs.writeFileSync(PERSIST_PRESENCE, JSON.stringify(presenceDocs.map(d => d.toJSON())));
        } catch (err) {
            // Ignore persistence errors
        }
    }, 30000);
    return interval;
}

export { loadPersistedData, startPersistence };
