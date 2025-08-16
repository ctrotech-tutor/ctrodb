// hydrodb/src/adapter/idb-migration.js

/**
 * The internal name for our Full-Text Search (FTS) index collection.
 * Using a constant ensures consistency and prevents magic strings.
 * @private
 * @type {string}
 */
const FTS_INDEX_COLLECTION = '_ctro_fts_index';

/**
 * Creates a handler function for the IndexedDB 'upgradeneeden' event.
 * This function is responsible for creating and updating the database schema,
 * including user-defined collections and the internal FTS index.
 *
 * @param {import('../core/Schema').Schema} schema - The CtroDB Schema instance.
 * @param {import('../core/Logger.js').Logger} logger - The logger instance.
 * @returns {function(IDBVersionChangeEvent): void} The onupgradeneeded callback.
 */
export function createMigrationHandler(schema, logger) {
  /**
   * @param {IDBVersionChangeEvent} event - The event object provided by IndexedDB.
   */
  return function handleUpgrade(event) {
    const db = event.target.result;
    logger.info('Migration', `Upgrading database to version ${db.version}...`);

    let hasSearchableFields = false;

    // First, create all the user-defined collections and their indexes.
    for (const collectionName in schema.collections) {
      const collectionSchema = schema.collections[collectionName];

      if (!db.objectStoreNames.contains(collectionName)) {
        const objectStore = db.createObjectStore(collectionName, { keyPath: 'id', autoIncrement: true });
        logger.debug('Migration', `Created object store: ${collectionName}`);

        if (collectionSchema.indexes && Array.isArray(collectionSchema.indexes)) {
          collectionSchema.indexes.forEach(indexName => {
            if (collectionSchema.fields[indexName]) {
              objectStore.createIndex(indexName, indexName, { unique: false });
              logger.debug('Migration', `Created index '${indexName}' on object store '${collectionName}'`);
            } else {
              logger.warn('Migration', `Cannot create index for '${indexName}' as it is not a defined field in the schema for '${collectionName}'.`);
            }
          });
        }
      } else {
        logger.debug('Migration', `Object store '${collectionName}' already exists.`);
      }

      // Check if this collection has any searchable fields.
      if (collectionSchema.searchable && Array.isArray(collectionSchema.searchable) && collectionSchema.searchable.length > 0) {
        hasSearchableFields = true;
      }
    }

    // --- Internal FTS Index Creation ---
    // After setting up user collections, check if we need to create our internal FTS index.
    if (hasSearchableFields && !db.objectStoreNames.contains(FTS_INDEX_COLLECTION)) {
      logger.info('Migration', 'Searchable fields detected. Creating internal Full-Text Search index.');
      
      // The FTS index stores tokens as keys. The keyPath is 'token'.
      // We do NOT use autoIncrement here because the token itself is the unique key.
      db.createObjectStore(FTS_INDEX_COLLECTION, { keyPath: 'token' });
      logger.debug('Migration', `Created internal object store: ${FTS_INDEX_COLLECTION}`);
    }
  };
}
