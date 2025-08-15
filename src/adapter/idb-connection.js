// hydrodb/src/adapter/idb-connection.js

/**
 * Opens and manages a connection to an IndexedDB database.
 * This function wraps the IndexedDB open request in a Promise for easier async handling.
 * It does NOT handle the migration (onupgradeneeden) logic, which will be passed in by the caller.
 *
 * @param {string} dbName - The name of the database to open.
 * @param {number} version - The version of the database to open.
 * @param {function(IDBVersionChangeEvent): void} onUpgradeNeeded - A callback function to handle the 'upgradeneeded' event.
 *   This is where database schema migrations will be defined.
 * @param {import('../core/Logger.js').Logger} logger - The logger instance.
 * @returns {Promise<IDBDatabase>} A promise that resolves with the database connection object (db) on success,
 *   or rejects with an error on failure.
 */
export function openDB(dbName, version, onUpgradeNeeded, logger) {
  return new Promise((resolve, reject) => {
    logger.debug('Connection', `Requesting to open database '${dbName}' with version ${version}.`);
    
    // Request to open the database.
    const request = window.indexedDB.open(dbName, version);

    // Event handler for when the database needs to be created or upgraded.
    // This is the ONLY place where the database schema can be modified.
    request.onupgradeneeded = onUpgradeNeeded;

    // Event handler for a successful database connection.
    request.onsuccess = (event) => {
      const db = event.target.result;
      logger.debug('Connection', `Successfully opened database: ${dbName} (v${version})`);
      resolve(db);
    };

    // Event handler for an error during the connection process.
    request.onerror = (event) => {
      const errorMessage = `Failed to open database: ${dbName}`;
      logger.error('Connection', errorMessage, event.target.error);
      reject(event.target.error);
    };

    // Event handler for when the connection is blocked by another open connection
    // from a different tab or window.
    request.onblocked = () => {
      const warnMessage = `Database connection to '${dbName}' is blocked. Please close other tabs using this database.`;
      logger.warn('Connection', warnMessage);
      // We could reject here, but often it's better to just warn the user.
      // For a robust library, you might implement a timeout or a more graceful handling mechanism.
    };
  });
}
