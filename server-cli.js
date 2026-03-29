#!/usr/bin/env node
import { startServer } from "./server.js";
import { OVCSSETTINGS } from "./const.js";

const args = process.argv.slice(2);

function getArg(flag, defaultValue) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    return defaultValue;
}

const port = parseInt(getArg('--port', OVCSSETTINGS.OVCS_SYNC_PORT), 10);
const host = getArg('--host', undefined);

startServer({ port, host });
