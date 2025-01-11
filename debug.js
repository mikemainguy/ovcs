const DEBUG = process.env.DEBUG_OVCS;
function debug(...message) {
    if (DEBUG) {
        console.log(message);
    }
}
export { debug };