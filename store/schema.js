// RxDB Schema for file documents (metadata-only — no content stored)
const fileSchema = {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
        id:        { type: 'string', maxLength: 100 },
        file:      { type: 'string' },
        type:      { type: 'string' },
        hash:      { type: 'string' },
        revisions: { type: 'object' },
        updatedAt: { type: 'number' }
    },
    required: ['id', 'file', 'type', 'hash']
};

// Conflict handler: merges per-user revisions, keeps newest hash
const ovcsConflictHandler = {
    isEqual(a, b) {
        return a.hash === b.hash && a.updatedAt === b.updatedAt;
    },
    resolve(input) {
        const master = input.assumedMasterState;
        const incoming = input.newDocumentState;

        // If no master state, incoming wins
        if (!master) return incoming;
        // If no incoming, master wins
        if (!incoming) return master;

        const merged = { ...master };

        // Merge revisions maps — keep all users' latest revisions
        merged.revisions = { ...(master.revisions || {}), ...(incoming.revisions || {}) };

        // For overlapping users, keep the newer revision
        if (master.revisions && incoming.revisions) {
            for (const email of Object.keys(incoming.revisions)) {
                if (master.revisions[email]) {
                    const masterDate = new Date(master.revisions[email].updated || 0);
                    const incomingDate = new Date(incoming.revisions[email].updated || 0);
                    if (incomingDate > masterDate) {
                        merged.revisions[email] = incoming.revisions[email];
                    } else {
                        merged.revisions[email] = master.revisions[email];
                    }
                }
            }
        }

        // Use the most recent hash
        if ((incoming.updatedAt || 0) > (master.updatedAt || 0)) {
            merged.hash = incoming.hash;
            merged.updatedAt = incoming.updatedAt;
        }

        return merged;
    }
};

export { fileSchema, ovcsConflictHandler };
