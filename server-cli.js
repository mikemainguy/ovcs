#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./server/index.js";
import { OVCSSETTINGS } from "./const.js";

const __dirname = import.meta.dirname || dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
console.log(`ovcs-server v${pkg.version}`);

const args = process.argv.slice(2);

function getArg(flag, defaultValue) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    return defaultValue;
}

const port = parseInt(getArg('--port', OVCSSETTINGS.OVCS_SYNC_PORT), 10);
const host = getArg('--host', undefined);
const tls = !args.includes('--no-tls');
const cert = getArg('--cert', undefined);
const key = getArg('--key', undefined);

startServer({ port, host, tls, cert, key });
