import {existsSync} from "node:fs";
import fs from "node:fs";
import {debug} from "./debug.js";
const defaultMetadata = {
    'email': 'ovc',
    'remote': '',
    'ignore': ['dist', 'node_modules', '.git', '.ovc', '.idea'],
}

function setupMetadata(override, pwd) {
    const exists = existsSync('.ovc');
    if (exists) {
        if (!override) {
            debug('.ovc directory already exists');
            const metadata = JSON.parse(fs.readFileSync(pwd+'/.ovc/ovc.json').toString('utf-8'));
            debug(metadata);
            return metadata;
        }
    } else {
        fs.mkdir(pwd + '/.ovc', function (err) {
            if (err) {
                console.error('Error creating .ovc directory:', err);
                process.exit(1);
            } else {
                debug('.ovc directory created');
                fs.writeFile(pwd+ '/.ovc/ovc.json', JSON.stringify(defaultMetadata),
                    function (err) {
                        if (err) {
                            console.error('Error creating .ovc/ovc.json:', err);
                            process.exit(1);
                        } else {
                            debug('.ovc/ovc.json created');
                            const metadata = defaultMetadata;
                            debug(metadata);
                            return metadata;
                        }
                    });
            }
        });
    }
    return null;
}
export {setupMetadata};