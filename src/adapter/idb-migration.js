// hydrodb/src/adapter/idb-migration.js

/**
 * Creates a handler function for the IndexedDB 'upgradeneeded' event.
 * This function is responsible for creating and updating the database schema (Object Stores and Indexes)
 * based on the provided HydroDB Schema object.
 *
 * @param {import('../core/Schema').Schema} schema - The HydroDB Schema instance that defines the database structure.
 * @param {import('../core/Logger.js').Logger} logger - The logger instance.
 * @returns {function(IDBVersionChangeEvent): void} A function designed to be used as the onupgradeneeded callback.
 */
export function createMigrationHandler(schema, logger) {
  /**
   * @param {IDBVersionChangeEvent} event - The event object provided by IndexedDB during a version change.
   */
  return function handleUpgrade(event) {
    const db = event.target.result;
    logger.info('Migration', `Upgrading database to version ${db.version}...`);

    for (const collectionName in schema.collections) {
      const collectionSchema = schema.collections[collectionName];

      // Check if the Object Store (table) already exists.
      if (!db.objectStoreNames.contains(collectionName)) {
        // Create the Object Store. We use 'id' as the keyPath by default.
        // autoIncrement: true ensures that IndexedDB handles unique ID generation for us.
        const objectStore = db.createObjectStore(collectionName, { keyPath: 'id', autoIncrement: true });
        logger.debug('Migration', `Created object store: ${collectionName}`);

        // Create indexes for the fields specified in the schema.
        if (collectionSchema.indexes && Array.isArray(collectionSchema.indexes)) {
          collectionSchema.indexes.forEach(indexName => {
            // Ensure the field actually exists before creating an index for it.
            if (collectionSchema.fields[indexName]) {
              // The third argument, options, can specify if the index is unique.
              objectStore.createIndex(indexName, indexName, { unique: false });
              logger.debug('Migration', `Created index '${indexName}' on object store '${collectionName}'`);
            } else {
              logger.warn('Migration', `Cannot create index for '${indexName}' as it is not a defined field in the schema for '${collectionName}'.`);
            }
          });
        }
      } else {
        // In a more advanced implementation, this is where you would handle
        // migrating existing object stores, e.g., adding/removing indexes
        // based on the oldVersion and newVersion from the event object.
        // For now, we only handle creation.
        logger.debug('Migration', `Object store '${collectionName}' already exists.`);
      }
    }
  };
}
