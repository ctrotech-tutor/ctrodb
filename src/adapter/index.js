// hydrodb/src/adapter/index.js

import { openDB } from './idb-connection.js';
import { createMigrationHandler } from './idb-migration.js';
import {
  createRecord,
  findRecord,
  findAllRecords,
  findRecordsByIndex,
  findRecordsByKeyRange,
  updateRecord,
  deleteRecord
} from './idb-crud.js';
import { tokenize } from '../utils/tokenizer.js';

// --- Constants ---
const FTS_INDEX_COLLECTION = '_ctro_fts_index';

// --- Private Helper Functions ---

function createKeyRange(condition) {
  const { op, value } = condition;
  switch (op) {
    case '>': return IDBKeyRange.lowerBound(value, true);
    case '>=': return IDBKeyRange.lowerBound(value);
    case '<': return IDBKeyRange.upperBound(value, true);
    case '<=': return IDBKeyRange.upperBound(value);
    default: return null;
  }
}

function recordMatches(record, conditions) {
  // This now only needs to handle 'where' conditions, as 'search' is handled separately.
  return conditions.every(condition => {
    if (condition.type !== 'where') return true;
    const { field, op, value } = condition;
    const recordValue = record[field];
    switch (op) {
      case '==': return recordValue === value;
      case '!=': return recordValue !== value;
      case '>': return recordValue > value;
      case '>=': return recordValue >= value;
      case '<': return recordValue < value;
      case '<=': return recordValue <= value;
      default: return false;
    }
  });
}

// --- The Adapter Class ---

export class IndexedDBAdapter {
  schema;
  #logger;
  #db = null;
  #dbName;
  #emitter = null;

  constructor(schema, logger, dbName = 'CtroDB') {
    if (!schema) throw new Error('IndexedDBAdapter requires a schema.');
    if (!logger) throw new Error('IndexedDBAdapter requires a logger.');
    
    this.schema = schema;
    this.#logger = logger;
    this.#dbName = dbName;
  }

  setEmitter(emitter) { this.#emitter = emitter; }

  async connect() {
    if (this.#db) return;
    this.#logger.debug('Adapter', 'Connecting to IndexedDB...');
    const migrationHandler = createMigrationHandler(this.schema, this.#logger);
    this.#db = await openDB(this.#dbName, this.schema.version, migrationHandler, this.#logger);
    this.#logger.debug('Adapter', 'Connection to IndexedDB successful.');
  }

  disconnect() {
    if (this.#db) {
      this.#db.close();
      this.#db = null;
      this.#logger.debug('Adapter', 'Disconnected from IndexedDB.');
    }
  }

  #ensureConnected() {
    if (!this.#db) {
      const errorMessage = 'Database is not connected. Please call connect() first.';
      this.#logger.error('Adapter', errorMessage);
      throw new Error(errorMessage);
    }
  }

  #emitChange(collectionName, record) {
    if (this.#emitter) {
      this.#emitter.emit('change', { collectionName, record });
      this.#logger.debug('Adapter', `Emitted 'change' event for '${collectionName}'.`, record);
    }
  }

  // --- FTS Indexing Helper Methods ---

  #getTokensFromRecord(collectionName, record) {
    const collectionSchema = this.schema.collections[collectionName];
    const searchableFields = collectionSchema.searchable || [];
    if (searchableFields.length === 0) {
      return new Set();
    }
    const allTokens = new Set();
    for (const field of searchableFields) {
      const text = record[field];
      const tokens = tokenize(text);
      for (const token of tokens) {
        allTokens.add(token);
      }
    }
    return allTokens;
  }

  async #updateFtsIndex(collectionName, docId, oldRecord, newRecord) {
    this.#ensureConnected();
    const oldTokens = oldRecord ? this.#getTokensFromRecord(collectionName, oldRecord) : new Set();
    const newTokens = newRecord ? this.#getTokensFromRecord(collectionName, newRecord) : new Set();
    const tokensToAdd = new Set([...newTokens].filter(token => !oldTokens.has(token)));
    const tokensToRemove = new Set([...oldTokens].filter(token => !newTokens.has(token)));
    if (tokensToAdd.size === 0 && tokensToRemove.size === 0) return;

    this.#logger.debug('Adapter-FTS', `Updating FTS index for docId ${docId}.`, { tokensToAdd, tokensToRemove });
    const tx = this.#db.transaction(FTS_INDEX_COLLECTION, 'readwrite');
    const ftsStore = tx.objectStore(FTS_INDEX_COLLECTION);

    for (const token of tokensToAdd) {
      const req = ftsStore.get(token);
      const indexRecord = await new Promise(resolve => req.onsuccess = () => resolve(req.result));
      if (indexRecord) {
        indexRecord.docs.push(docId);
        ftsStore.put(indexRecord);
      } else {
        ftsStore.put({ token, docs: [docId] });
      }
    }

    for (const token of tokensToRemove) {
      const req = ftsStore.get(token);
      const indexRecord = await new Promise(resolve => req.onsuccess = () => resolve(req.result));
      if (indexRecord) {
        indexRecord.docs = indexRecord.docs.filter(id => id !== docId);
        if (indexRecord.docs.length > 0) {
          ftsStore.put(indexRecord);
        } else {
          ftsStore.delete(token);
        }
      }
    }

    await new Promise(resolve => tx.oncomplete = resolve);
    this.#logger.debug('Adapter-FTS', `FTS index update complete for docId ${docId}.`);
  }

  // --- CRUD Methods (with FTS Hooks) ---

  async create(collectionName, data) {
    this.#ensureConnected();
    const newRecord = await createRecord(this.#db, collectionName, data, this.#logger);
    await this.#updateFtsIndex(collectionName, newRecord.id, null, newRecord);
    this.#emitChange(collectionName, newRecord);
    return newRecord;
  }

  async update(collectionName, id, data) {
    this.#ensureConnected();
    const oldRecord = await findRecord(this.#db, collectionName, id, this.#logger);
    if (!oldRecord) throw new Error(`Cannot update non-existent record with id ${id}.`);
    const updatedRecord = await updateRecord(this.#db, collectionName, id, data, this.#logger);
    await this.#updateFtsIndex(collectionName, id, oldRecord, updatedRecord);
    this.#emitChange(collectionName, updatedRecord);
    return updatedRecord;
  }

  async delete(collectionName, id) {
    this.#ensureConnected();
    const recordToDelete = await findRecord(this.#db, collectionName, id, this.#logger);
    if (recordToDelete) {
      await deleteRecord(this.#db, collectionName, id, this.#logger);
      await this.#updateFtsIndex(collectionName, id, recordToDelete, null);
      this.#emitChange(collectionName, recordToDelete);
    }
  }

  // --- Query Methods ---

  find(collectionName, id) {
    this.#ensureConnected();
    return findRecord(this.#db, collectionName, id, this.#logger);
  }

  findAll(collectionName) {
    this.#ensureConnected();
    return findAllRecords(this.#db, collectionName, this.#logger);
  }

  async #executeFtsSearch(searchCondition) {
    this.#logger.debug('Adapter-FTS', `Executing FTS search for: "${searchCondition.value}"`);
    const searchTokens = tokenize(searchCondition.value);
    if (searchTokens.length === 0) return new Set();

    const tx = this.#db.transaction(FTS_INDEX_COLLECTION, 'readonly');
    const ftsStore = tx.objectStore(FTS_INDEX_COLLECTION);
    let matchingDocIds = null;

    for (const token of searchTokens) {
      const req = ftsStore.get(token);
      const indexRecord = await new Promise(resolve => req.onsuccess = () => resolve(req.result));
      const idsForToken = new Set(indexRecord ? indexRecord.docs : []);
      if (matchingDocIds === null) {
        matchingDocIds = idsForToken;
      } else {
        matchingDocIds = new Set([...matchingDocIds].filter(id => idsForToken.has(id)));
      }
      if (matchingDocIds.size === 0) break;
    }
    
    this.#logger.debug('Adapter-FTS', `FTS search found ${matchingDocIds?.size || 0} potential document IDs.`);
    return matchingDocIds || new Set();
  }

  async #executeConditionGroup(collectionName, conditions) {
    if (conditions.length === 0) return this.findAll(collectionName);

    const searchConditions = conditions.filter(c => c.type === 'search');
    const whereConditions = conditions.filter(c => c.type === 'where');
    let initialRecordSet = null;

    if (searchConditions.length > 0) {
      const ftsDocIds = await this.#executeFtsSearch(searchConditions[0]);
      if (ftsDocIds.size === 0) return [];

      const tx = this.#db.transaction(collectionName, 'readonly');
      const store = tx.objectStore(collectionName);
      initialRecordSet = await Promise.all(
        [...ftsDocIds].map(id => new Promise(resolve => {
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result);
        }))
      );
      initialRecordSet = initialRecordSet.filter(Boolean);
    }

    const recordsToFilter = initialRecordSet !== null ? initialRecordSet : await this.findAll(collectionName);
    if (whereConditions.length === 0) return recordsToFilter;

    this.#logger.debug('Adapter', `Applying 'where' filters to a set of ${recordsToFilter.length} records.`);
    return recordsToFilter.filter(record => recordMatches(record, whereConditions));
  }

  async executeQuery(collectionName, conditionGroups) {
    this.#ensureConnected();
    this.#logger.debug('Adapter', `Executing query for '${collectionName}'.`, conditionGroups);

    if (conditionGroups.length === 0 || (conditionGroups.length === 1 && conditionGroups[0].length === 0)) {
      return this.findAll(collectionName);
    }
    if (conditionGroups.length === 1) {
      return this.#executeConditionGroup(collectionName, conditionGroups[0]);
    }

    this.#logger.debug('Adapter', `Executing OR query with ${conditionGroups.length} groups.`);
    const resultsFromGroups = await Promise.all(
      conditionGroups.map(group => this.#executeConditionGroup(collectionName, group))
    );

    const resultMap = new Map();
    for (const groupResults of resultsFromGroups) {
      for (const record of groupResults) {
        if (!resultMap.has(record.id)) {
          resultMap.set(record.id, record);
        }
      }
    }

    this.#logger.debug('Adapter', `OR query finished. Found ${resultMap.size} unique records.`);
    return Array.from(resultMap.values());
  }
}
