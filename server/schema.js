// Schemas (same as client — metadata only, no content stored)
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

const presenceSchema = {
    version: 0,
    primaryKey: 'id',
    type: 'object',
    properties: {
        id:          { type: 'string', maxLength: 100 },
        clientId:    { type: 'string' },
        email:       { type: 'string' },
        hostname:    { type: 'string' },
        projectPath: { type: 'string' },
        nodeType:    { type: 'string' },
        lastSeen:    { type: 'string' },
        startedAt:   { type: 'string' },
        status:      { type: 'string' },
        activeFiles: { type: 'array', items: { type: 'string' } },
        fileFilter:  { type: 'object' },
        teamId:      { type: 'string' },
        gitBranch:   { type: 'string' },
        gitCommitHash: { type: 'string' },
        updatedAt:   { type: 'number' }
    },
    required: ['id', 'email', 'status']
};

const ovcsConflictHandler = {
    isEqual(a, b) {
        return a.hash === b.hash && a.updatedAt === b.updatedAt;
    },
    resolve(input) {
        const master = input.assumedMasterState;
        const incoming = input.newDocumentState;
        if (!master) return incoming;
        if (!incoming) return master;
        const merged = { ...master };
        merged.revisions = { ...(master.revisions || {}), ...(incoming.revisions || {}) };
        if (master.revisions && incoming.revisions) {
            for (const email of Object.keys(incoming.revisions)) {
                if (master.revisions[email]) {
                    const masterDate = new Date(master.revisions[email].updated || 0);
                    const incomingDate = new Date(incoming.revisions[email].updated || 0);
                    merged.revisions[email] = incomingDate > masterDate
                        ? incoming.revisions[email]
                        : master.revisions[email];
                }
            }
        }
        if ((incoming.updatedAt || 0) > (master.updatedAt || 0)) {
            merged.hash = incoming.hash;
            merged.updatedAt = incoming.updatedAt;
        }
        return merged;
    }
};

const presenceConflictHandler = {
    isEqual(a, b) {
        return a?.lastSeen === b?.lastSeen && a?.status === b?.status;
    },
    resolve(input) {
        const master = input.assumedMasterState;
        const incoming = input.newDocumentState;
        if (!master) return incoming;
        if (!incoming) return master;
        return new Date(incoming.lastSeen || 0) >= new Date(master.lastSeen || 0)
            ? incoming
            : master;
    }
};

export { fileSchema, presenceSchema, ovcsConflictHandler, presenceConflictHandler };
