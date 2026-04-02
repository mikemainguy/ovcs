import { addRxPlugin, createRxDatabase } from "rxdb";
import { wrappedValidateAjvStorage } from "rxdb/plugins/validate-ajv";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import fs from "node:fs";
import { OVCSSETTINGS } from "../const.js";
import { debug } from "../debug.js";
import { fileSchema, presenceSchema, ovcsConflictHandler, presenceConflictHandler } from "./schema.js";

if (process.env.DEBUG_OVCS) {
    const { RxDBDevModePlugin } = await import("rxdb/plugins/dev-mode");
    addRxPlugin(RxDBDevModePlugin);
}

const DATA_DIR = `./${OVCSSETTINGS.ROOT_DIR}/server-data`;

function getStorage() {
    return wrappedValidateAjvStorage({ storage: getRxStorageMemory() });
}

async function createServerDatabase() {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const db = await createRxDatabase({
        name: `${DATA_DIR}/serverdb`,
        storage: getStorage(),
        multiInstance: false
    });

    await db.addCollections({
        files: {
            schema: fileSchema,
            conflictHandler: ovcsConflictHandler
        },
        presence: {
            schema: presenceSchema,
            conflictHandler: presenceConflictHandler
        }
    });

    return db;
}

export { createServerDatabase, DATA_DIR };
