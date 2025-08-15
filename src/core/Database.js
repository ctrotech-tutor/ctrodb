// hydrodb/src/core/Database.js

import { IndexedDBAdapter } from '../adapter/index.js';
import { Collection } from './Collection.js';
import { Emitter } from './Emitter.js';
import { Logger, LogLevel } from './Logger.js'; // Import the new Logger classes

/**
 * @class Database
 * @description The main class and entry point for interacting with a HydroDB database.
 * It manages the database connection, event emissions, and provides access to collections.
 */
export class Database {
  /**
   * @private
   * @type {import('../adapter/index.js').IndexedDBAdapter}
   */
  #adapter;

  /**
   * @private
   * @type {Map<string, Collection>}
   */
  #collections = new Map();

  /**
   * @public
   * @readonly
   * @type {Emitter}
   */
  emitter;

  /**
   * The logger instance for the database.
   * @public
   * @readonly
   * @type {Logger}
   */
  logger;

  /**
   * @constructor
   * @param {object} config - The database configuration object.
   * @param {import('./Schema').Schema} config.schema - The schema for the database.
   * @param {string} [config.dbName='HydroDB'] - The name of the database.
   * @param {number} [config.logLevel=LogLevel.NONE] - The desired logging level.
   */
  constructor(config) {
    if (!config || !config.schema) {
      throw new Error('Database constructor requires a configuration object with a schema.');
    }

    // Initialize the logger first, so all subsequent steps can use it.
    this.logger = new Logger(config.logLevel || LogLevel.NONE);
    this.logger.info('Database', 'Initializing...');

    this.emitter = new Emitter();
    
    // Pass the logger instance to the adapter.
    this.#adapter = new IndexedDBAdapter(config.schema, this.logger, config.dbName);
    this.#adapter.setEmitter(this.emitter);
    this.logger.debug('Database', 'Adapter initialized.');
  }

  /**
   * Initializes the database by connecting the underlying adapter.
   * This must be called before performing any operations.
   * @returns {Promise<void>}
   */
  async connect() {
    this.logger.info('Database', 'Connecting...');
    await this.#adapter.connect();
    this.logger.info('Database', 'Connection successful. HydroDB is ready.');
  }

  /**
   * Closes the database connection.
   * @returns {void}
   */
  disconnect() {
    this.logger.info('Database', 'Disconnecting...');
    this.#adapter.disconnect();
  }

  /**
   * Gets a collection instance by name.
   * This is the primary method for accessing data.
   *
   * @param {string} name - The name of the collection to retrieve.
   * @returns {Collection} A collection object for performing operations.
   * @throws {Error} If the collection name is not defined in the schema.
   */
  getCollection(name) {
    if (!this.#adapter.schema.collections[name]) {
       const errorMessage = `Collection with name "${name}" does not exist in the schema.`;
       this.logger.error('Database', errorMessage);
       throw new Error(errorMessage);
    }

    if (this.#collections.has(name)) {
      return this.#collections.get(name);
    }

    this.logger.debug('Database', `Creating new collection instance for '${name}'.`);
    // Pass the logger instance to the Collection constructor.
    const collection = new Collection(name, this.#adapter, this, this.logger);
    this.#collections.set(name, collection);
    return collection;
  }
}
