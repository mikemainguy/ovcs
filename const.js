const OVCSSETTINGS = {
    ROOT_DIR: '.ovcs',
    OVCS_WEB_PORT: process.env.OVCS_WEB_PORT || 3001,
    OVCS_SYNC_PORT: process.env.OVCS_SYNC_PORT || 5984,
    // Vector DB settings
    VECTOR_DB_DIR: 'vectordb',
    MODELS_DIR: 'models',
    EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
    EMBEDDING_DIMENSIONS: 384,
    CHUNK_SIZE: 512,
    CHUNK_OVERLAP: 50,
    // Compression settings
    DEFAULT_COMPRESSION_ALGORITHM: 'gzip',
    DEFAULT_COMPRESSION_LEVEL: 6,
    // Presence/discovery settings
    PRESENCE_DB_PREFIX: 'ovcs-presence-',
    HEARTBEAT_INTERVAL: 30000,
    STALE_TIMEOUT: 120000,
    // Language mappings for AST parsing
    LANGUAGE_MAP: {
        '.js': 'javascript',
        '.mjs': 'javascript',
        '.jsx': 'javascript',
        '.ts': 'typescript',
        '.tsx': 'typescript'
    }
}
export {OVCSSETTINGS};
