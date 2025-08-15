// hydrodb/src/adapter/idb-crud.js

/**
 * A collection of functions to perform Create, Read, Update, and Delete (CRUD)
 * operations on a given IndexedDB database connection. Each function is designed
 * to be robust, promise-based, and handles its own transaction lifecycle.
 */

export function createRecord(db, collectionName, data, logger) {
  return new Promise((resolve, reject) => {
    logger.debug('CRUD', `Creating record in '${collectionName}'.`, data);
    const transaction = db.transaction(collectionName, 'readwrite');
    const objectStore = transaction.objectStore(collectionName);
    const request = objectStore.add(data);

    request.onsuccess = (event) => {
      const id = event.target.result;
      logger.debug('CRUD', `Successfully created record with new ID: ${id}.`);
      resolve({ ...data, id });
    };
    request.onerror = (event) => {
      logger.error(`CRUD`, `Error creating record in '${collectionName}':`, event.target.error);
      reject(event.target.error);
    };
  });
}

export function findRecord(db, collectionName, id, logger) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(collectionName, 'readonly');
    const objectStore = transaction.objectStore(collectionName);
    const request = objectStore.get(id);

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => {
      logger.error(`CRUD`, `Error finding record with id '${id}' in '${collectionName}':`, event.target.error);
      reject(event.target.error);
    };
  });
}

export function findAllRecords(db, collectionName, logger) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(collectionName, 'readonly');
    const objectStore = transaction.objectStore(collectionName);
    const request = objectStore.getAll();

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => {
      logger.error(`CRUD`, `Error finding all records in '${collectionName}':`, event.target.error);
      reject(event.target.error);
    };
  });
}

export function findRecordsByIndex(db, collectionName, indexName, value, logger) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(collectionName, 'readonly');
    const objectStore = transaction.objectStore(collectionName);
    const index = objectStore.index(indexName);
    const request = index.getAll(value);

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => {
      logger.error(`CRUD`, `Error finding records by index '${indexName}' in '${collectionName}':`, event.target.error);
      reject(event.target.error);
    };
  });
}

/**
 * Finds records using an index and a key range. This is the most powerful method
 * for performing efficient range queries (e.g., >, <, >=, <=).
 *
 * @param {IDBDatabase} db - The open IndexedDB database connection.
 * @param {string} collectionName - The name of the object store (collection).
 * @param {string} indexName - The name of the index to query.
 * @param {IDBKeyRange} keyRange - The IDBKeyRange object that defines the query boundaries.
 * @param {import('../core/Logger.js').Logger} logger - The logger instance.
 * @returns {Promise<Array<object>>} A promise that resolves with an array of matching records.
 */
export function findRecordsByKeyRange(db, collectionName, indexName, keyRange, logger) {
  return new Promise((resolve, reject) => {
    logger.debug('CRUD', `Finding records in '${collectionName}' on index '${indexName}' using key range.`);
    const transaction = db.transaction(collectionName, 'readonly');
    const objectStore = transaction.objectStore(collectionName);
    const index = objectStore.index(indexName);
    // Use the keyRange object directly in the getAll() call.
    const request = index.getAll(keyRange);

    request.onsuccess = (event) => {
      logger.debug('CRUD', `Key range query successful, found ${event.target.result.length} records.`);
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      logger.error(`CRUD`, `Error finding records by key range on index '${indexName}':`, event.target.error);
      reject(event.target.error);
    };
  });
}

export function updateRecord(db, collectionName, id, data, logger) {
  return new Promise((resolve, reject) => {
    logger.debug('CRUD', `Updating record '${id}' in '${collectionName}'.`, data);
    const transaction = db.transaction(collectionName, 'readwrite');
    const objectStore = transaction.objectStore(collectionName);
    const getRequest = objectStore.get(id);

    getRequest.onerror = (event) => {
      logger.error(`CRUD`, `Error fetching record for update with id '${id}' in '${collectionName}':`, event.target.error);
      reject(event.target.error);
    };
    getRequest.onsuccess = (event) => {
      const existingRecord = event.target.result;
      if (!existingRecord) {
        const notFoundError = new Error(`Record with id '${id}' not found in '${collectionName}'.`);
        logger.error('CRUD', notFoundError.message);
        return reject(notFoundError);
      }
      const updatedRecord = { ...existingRecord, ...data };
      const putRequest = objectStore.put(updatedRecord);
      putRequest.onsuccess = () => {
        logger.debug('CRUD', `Successfully updated record with id '${id}'.`);
        resolve(updatedRecord);
      };
      putRequest.onerror = (event) => {
        logger.error(`CRUD`, `Error updating record with id '${id}' in '${collectionName}':`, event.target.error);
        reject(event.target.error);
      };
    };
  });
}

export function deleteRecord(db, collectionName, id, logger) {
  return new Promise((resolve, reject) => {
    logger.debug('CRUD', `Deleting record with id '${id}' from '${collectionName}'.`);
    const transaction = db.transaction(collectionName, 'readwrite');
    const objectStore = transaction.objectStore(collectionName);
    const request = objectStore.delete(id);

    request.onsuccess = () => {
      logger.debug('CRUD', `Successfully deleted record with id '${id}'.`);
      resolve();
    };
    request.onerror = (event) => {
      logger.error(`CRUD`, `Error deleting record with id '${id}' in '${collectionName}':`, event.target.error);
      reject(event.target.error);
    };
  });
}
