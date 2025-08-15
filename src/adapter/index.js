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
  return conditions.every(condition => {
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

export class IndexedDBAdapter {
  schema;
  #logger;
  #db = null;
  #dbName;
  #emitter = null;

  constructor(schema, logger, dbName = 'HydroDB') {
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

  // --- CRUD Methods ---
  async create(collectionName, data) {
    this.#ensureConnected();
    const newRecord = await createRecord(this.#db, collectionName, data, this.#logger);
    this.#emitChange(collectionName, newRecord);
    return newRecord;
  }
  find(collectionName, id) {
    this.#ensureConnected();
    return findRecord(this.#db, collectionName, id, this.#logger);
  }
  findAll(collectionName) {
    this.#ensureConnected();
    return findAllRecords(this.#db, collectionName, this.#logger);
  }
  async update(collectionName, id, data) {
    this.#ensureConnected();
    const updatedRecord = await updateRecord(this.#db, collectionName, id, data, this.#logger);
    this.#emitChange(collectionName, updatedRecord);
    return updatedRecord;
  }
  async delete(collectionName, id) {
    this.#ensureConnected();
    const recordToDelete = await findRecord(this.#db, collectionName, id, this.#logger);
    await deleteRecord(this.#db, collectionName, id, this.#logger);
    if (recordToDelete) this.#emitChange(collectionName, recordToDelete);
  }

  /**
   * A private helper to execute a single group of AND conditions.
   * @param {string} collectionName
   * @param {Array<object>} conditions
   * @returns {Promise<Array<object>>}
   */
  async #executeConditionGroup(collectionName, conditions) {
    if (conditions.length === 0) {
      return this.findAll(collectionName);
    }

    const collectionSchema = this.schema.collections[collectionName];
    const indexedCondition = conditions.find(c => collectionSchema.indexes?.includes(c.field));

    if (indexedCondition) {
      const { field, op, value } = indexedCondition;
      let indexedResults;

      if (op === '==') {
        this.#logger.debug('Adapter', `Using index '${field}' with '==' operator.`);
        indexedResults = await findRecordsByIndex(this.#db, collectionName, field, value, this.#logger);
      } else {
        const keyRange = createKeyRange(indexedCondition);
        if (keyRange) {
          this.#logger.debug('Adapter', `Using index '${field}' with a key range operator ('${op}').`);
          indexedResults = await findRecordsByKeyRange(this.#db, collectionName, field, keyRange, this.#logger);
        } else {
          // This case handles '!=' on an indexed field, which must be a full scan.
          this.#logger.warn('Adapter', `Operator '${op}' cannot use an index. Falling back to full scan.`);
          const allRecords = await this.findAll(collectionName);
          return allRecords.filter(record => recordMatches(record, conditions));
        }
      }
      
      const otherConditions = conditions.filter(c => c !== indexedCondition);
      if (otherConditions.length > 0) {
        this.#logger.debug('Adapter', 'Applying additional filtering to indexed results.');
        return indexedResults.filter(record => recordMatches(record, otherConditions));
      }
      return indexedResults;
    }

    this.#logger.warn('Adapter', `Executing non-indexed query for '${collectionName}'. This may be slow.`);
    const allRecords = await this.findAll(collectionName);
    return allRecords.filter(record => recordMatches(record, conditions));
  }

  /**
   * Executes a query against the database. This is the main query execution engine.
   * @param {string} collectionName - The name of the collection to query.
   * @param {Array<Array<object>>} conditionGroups - The query conditions from the Query class.
   * @returns {Promise<Array<object>>}
   */
  async executeQuery(collectionName, conditionGroups) {
    this.#ensureConnected();
    this.#logger.debug('Adapter', `Executing query for '${collectionName}'.`, conditionGroups);

    if (conditionGroups.length === 0 || (conditionGroups.length === 1 && conditionGroups[0].length === 0)) {
      return this.findAll(collectionName);
    }

    // If there's only one group, execute it directly.
    if (conditionGroups.length === 1) {
      return this.#executeConditionGroup(collectionName, conditionGroups[0]);
    }

    // --- OR Logic: Multiple Condition Groups ---
    this.#logger.debug('Adapter', `Executing OR query with ${conditionGroups.length} groups.`);
    
    // Execute all condition groups in parallel.
    const resultsFromGroups = await Promise.all(
      conditionGroups.map(group => this.#executeConditionGroup(collectionName, group))
    );

    // Merge and de-duplicate the results.
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
