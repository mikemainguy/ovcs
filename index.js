#!/usr/bin/env node
import * as readline from "node:readline";
import {existsSync} from "node:fs";
import {watchDir} from "./watchdir.js";
import {setupMetadata} from "./setupMetadata.js";
import {OVCSSETTINGS} from "./const.js";
const rl = readline.createInterface({input: process.stdin, output: process.stdout});
const pwd = process.cwd();

function checkInit() {
    const exists = existsSync(`${pwd}/${OVCSSETTINGS.ROOT_DIR}`);
    console.log(exists);
    if (!exists) {
        console.log('.ovcs directory not found, initialize?');
        rl.question('Press [Y] to continue: ', ans => {
            if (ans === 'y') {
                rl.close();
                const metadata = setupMetadata(true, pwd);
                console.log(metadata);
                watchDir(metadata, pwd);
            } else {
                console.error('ovc not initialized');
                rl.close();
                process.exit(1);
            }
        });
    } else {
        const metadata = setupMetadata(false, pwd);
        watchDir(metadata, pwd);
    }
}
checkInit();
