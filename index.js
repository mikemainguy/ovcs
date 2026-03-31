#!/usr/bin/env node
import * as readline from "node:readline";
import {existsSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {watchDir} from "./watchdir.js";
import {setupMetadata, configureTls} from "./setupMetadata.js";
import {debug} from "./debug.js";
import {OVCSSETTINGS} from "./const.js";
import {startServer} from "./server.js";
import {stopPresence} from "./presence.js";
import {stopPersistence, stopReconciliationTimer} from "./dataStore.js";
import {stopP2P} from "./p2p.js";

const __dirname = import.meta.dirname || dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
console.log(`ovcs v${pkg.version}`);

const args = process.argv.slice(2);

// Graceful shutdown — mark presence as offline
function setupShutdownHandlers() {
    const shutdown = async () => {
        debug('\nShutting down...');
        stopReconciliationTimer();
        await stopPresence();
        await stopP2P();
        stopPersistence();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
setupShutdownHandlers();
const isServerMode = args.includes('--server');
const isP2PMode = args.includes('--p2p');

// Parse a --flag value pair from args
function getArg(flag, defaultValue) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    return defaultValue;
}

function getPort(defaultPort) {
    const val = getArg('--port', null);
    if (val !== null) {
        const port = parseInt(val, 10);
        if (!isNaN(port)) return port;
    }
    return defaultPort;
}

if (isServerMode) {
    // Server mode: start express-pouchdb replication hub
    const port = getPort(OVCSSETTINGS.OVCS_SYNC_PORT);
    const host = getArg('--host', undefined);
    const tls = !args.includes('--no-tls');
    const cert = getArg('--cert', undefined);
    const key = getArg('--key', undefined);
    startServer({ port, host, tls, cert, key });
} else {
    // Client mode: watch directory and sync
    if (args.includes('--allow-self-signed')) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        console.warn('[WARNING] TLS certificate verification is disabled (--allow-self-signed). This makes connections vulnerable to man-in-the-middle attacks. Consider using tls.caCert to trust a specific certificate instead.');
    }
    const rl = readline.createInterface({input: process.stdin, output: process.stdout});
    const pwd = process.cwd();
    const port = getPort(OVCSSETTINGS.OVCS_WEB_PORT);

    async function checkInit() {
        const exists = existsSync(`${pwd}/${OVCSSETTINGS.ROOT_DIR}`);
        debug(exists);
        if (!exists) {
            debug('.ovcs directory not found, initialize?');
            rl.question('Press [Y] to continue: ', async ans => {
                if (ans === 'y') {
                    rl.close();
                    const metadata = setupMetadata(true, pwd);
                    configureTls(metadata);
                    debug(metadata);
                    const baseDir = getArg('--dir', metadata.baseDirectory || '.');
                    await watchDir(metadata, pwd, port, { p2p: isP2PMode, baseDirectory: baseDir });
                } else {
                    console.error('ovc not initialized');
                    rl.close();
                    process.exit(1);
                }
            });
        } else {
            const metadata = setupMetadata(false, pwd);
            configureTls(metadata);
            const baseDir = getArg('--dir', metadata.baseDirectory || '.');
            await watchDir(metadata, pwd, port, { p2p: isP2PMode, baseDirectory: baseDir });
        }
    }
    checkInit();
}
