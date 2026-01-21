#!/usr/bin/env node
import * as readline from "node:readline";
import {existsSync} from "node:fs";
import {watchDir} from "./watchdir.js";
import {setupMetadata} from "./setupMetadata.js";
import {OVCSSETTINGS} from "./const.js";
import {startServer} from "./server.js";

const args = process.argv.slice(2);
const isServerMode = args.includes('--server');

// Parse --port flag
function getPort() {
    const portIdx = args.indexOf('--port');
    if (portIdx !== -1 && args[portIdx + 1]) {
        const port = parseInt(args[portIdx + 1], 10);
        if (!isNaN(port)) return port;
    }
    return OVCSSETTINGS.OVCS_SYNC_PORT;
}

if (isServerMode) {
    // Server mode: start express-pouchdb replication hub
    const port = getPort();
    startServer({ port });
} else {
    // Client mode: watch directory and sync
    const rl = readline.createInterface({input: process.stdin, output: process.stdout});
    const pwd = process.cwd();

    async function checkInit() {
        const exists = existsSync(`${pwd}/${OVCSSETTINGS.ROOT_DIR}`);
        console.log(exists);
        if (!exists) {
            console.log('.ovcs directory not found, initialize?');
            rl.question('Press [Y] to continue: ', async ans => {
                if (ans === 'y') {
                    rl.close();
                    const metadata = setupMetadata(true, pwd);
                    console.log(metadata);
                    await watchDir(metadata, pwd);
                } else {
                    console.error('ovc not initialized');
                    rl.close();
                    process.exit(1);
                }
            });
        } else {
            const metadata = setupMetadata(false, pwd);
            await watchDir(metadata, pwd);
        }
    }
    checkInit();
}
