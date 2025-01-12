import fs, {existsSync} from "node:fs";
import {debug} from "./debug.js";
import {OVCSSETTINGS} from "./const.js";
const defaultMetadata = {
    'email': 'ovcs',
    'remote': '',
    'ignore': ['dist', 'node_modules', '.git', '.ovcs', '.idea'],
}
function setupMetadata(override, pwd) {
    const dir = `${pwd}/${OVCSSETTINGS.ROOT_DIR}`;
    const exists = existsSync(dir);
    if (exists && !override) {
        debug('.ovcs directory already exists');
        const metadata = JSON.parse(fs.readFileSync(`${dir}/ovcs.json`).toString('utf-8'));
        debug(metadata);
        return metadata;
    } else {
        fs.mkdirSync(dir);
        debug('.ovc directory created');
        fs.writeFileSync(`${dir}/ovcs.json`, JSON.stringify(defaultMetadata));
        return defaultMetadata;
    }
}

export {setupMetadata};