// hydrodb/src/core/Collection.js

import { Model } from '../models/Model.js';
import { Query } from '../query/Query.js';

export class Collection {
  name;
  #adapter;
  #database;
  #logger;

  constructor(name, adapter, database, logger) {
    if (!name || typeof name !== 'string') throw new Error('Collection requires a name.');
    if (!adapter) throw new Error('Collection requires an adapter instance.');
    if (!database) throw new Error('Collection requires a database instance for relations.');
    if (!logger) throw new Error('Collection requires a logger instance.');

    this.name = name;
    this.#adapter = adapter;
    this.#database = database;
    this.#logger = logger;
  }

  #toModel(data) {
    if (!data) return undefined;
    return new Model(data, this, this.#database, this.#logger);
  }

  _toModelArray(dataArray) {
    return dataArray.map(data => this.#toModel(data));
  }

  /**
   * An "internal" method for the Model class to get its schema definition.
   * @returns {object} The schema definition for this specific collection.
   */
  _getCollectionSchema() {
    return this.#adapter.schema.collections[this.name];
  }

  async create(data) {
    this.#logger.debug('Collection', `create() called for '${this.name}'.`, data);
    try {
      const createdData = await this.#adapter.create(this.name, data);
      return this.#toModel(createdData);
    } catch (error) {
      this.#logger.error('Collection', `Error in create() for '${this.name}':`, error);
      throw error;
    }
  }

  async find(id) {
    this.#logger.debug('Collection', `find() called for '${this.name}' with id: ${id}.`);
    const foundData = await this.#adapter.find(this.name, id);
    return this.#toModel(foundData);
  }

  async findAll() {
    this.#logger.debug('Collection', `findAll() called for '${this.name}'.`);
    const allData = await this.#adapter.findAll(this.name);
    return this._toModelArray(allData);
  }

  async update(id, data) {
    this.#logger.debug('Collection', `update() called for '${this.name}' with id: ${id}.`, data);
    try {
      const updatedData = await this.#adapter.update(this.name, id, data);
      return this.#toModel(updatedData);
    } catch (error) {
      this.#logger.error('Collection', `Error in update() for '${this.name}':`, error);
      throw error;
    }
  }

  delete(id) {
    this.#logger.debug('Collection', `delete() called for '${this.name}' with id: ${id}.`);
    return this.#adapter.delete(this.name, id);
  }

  _executeQuery(conditions) {
    this.#logger.debug('Collection', `_executeQuery() called for '${this.name}'.`, conditions);
    return this.#adapter.executeQuery(this.name, conditions);
  }

  query() {
    this.#logger.debug('Collection', `query() called for '${this.name}'.`);
    return new Query(this, this.#database, this.#logger);
  }
}
