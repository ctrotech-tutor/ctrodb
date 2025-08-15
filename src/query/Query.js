// hydrodb/src/query/Query.js

/**
 * @class Query
 * @description A class for building and executing database queries.
 * It allows for chaining conditions and observing results for live updates.
 */
export class Query {
  /** @private @type {import('../core/Collection.js').Collection} */
  #collection;
  /** @private @type {import('../core/Database.js').Database} */
  #database;
  /** @private @type {import('../core/Logger.js').Logger} */
  #logger;

  /**
   * The main data structure for storing query conditions.
   * It's an array of "condition groups". Each group is an array of conditions
   * that are joined by AND. The top-level groups are joined by OR.
   * e.g., [ [A, B], [C] ] represents (A AND B) OR (C)
   * @private
   * @type {Array<Array<{field: string, op: string, value: any}>>}
   */
  #conditionGroups = [[]];

  /**
   * @constructor
   * @param {import('../core/Collection.js').Collection} collection
   * @param {import('../core/Database.js').Database} database
   * @param {import('../core/Logger.js').Logger} logger
   */
  constructor(collection, database, logger) {
    if (!collection) throw new Error('Query requires a collection instance.');
    if (!database) throw new Error('Query requires a database instance.');
    if (!logger) throw new Error('Query requires a logger instance.');
    
    this.#collection = collection;
    this.#database = database;
    this.#logger = logger;
  }

  /**
   * Adds a condition to the current query group (AND).
   * Can be called as where(field, value) for equality, or where(field, operator, value).
   * @param {string} field - The field to query on.
   * @param {string} opOrValue - The operator (e.g., '>', '!=') or the value for an equality check.
   * @param {any} [value] - The value to match (if an operator is provided).
   * @returns {Query} The Query instance for chaining.
   */
  where(field, opOrValue, value) {
    const supportedOps = ['==', '!=', '>', '<', '>=', '<='];
    let op, val;

    if (value === undefined) {
      op = '==';
      val = opOrValue;
    } else {
      op = opOrValue;
      val = value;
    }

    if (!supportedOps.includes(op)) {
      throw new Error(`Unsupported operator '${op}'. Supported operators are: ${supportedOps.join(', ')}`);
    }

    const lastGroup = this.#conditionGroups[this.#conditionGroups.length - 1];
    lastGroup.push({ field, op, value: val });

    this.#logger.debug('Query', `Added 'where' condition:`, { field, op, value: val });
    return this;
  }

  /**
   * Adds a new query group (OR).
   * @param {function(Query): void} callback - A function that receives a new query
   *   instance to define the conditions for the OR group.
   * @returns {Query} The Query instance for chaining.
   */
  orWhere(callback) {
    this.#logger.debug('Query', `Adding an 'orWhere' group.`);
    
    // Create a new, temporary Query instance for the callback to use.
    // This prevents the callback from affecting the main query's state directly.
    const orQuery = new Query(this.#collection, this.#database, this.#logger);
    callback(orQuery);

    // Add the conditions from the temporary query as a new group to our main query.
    // We only take the first group from the orQuery, as nested ORs are not supported in this design.
    const newGroup = orQuery.#conditionGroups[0];
    if (newGroup.length > 0) {
      this.#conditionGroups.push(newGroup);
    }

    return this;
  }

  /**
   * Executes the query and fetches the first matching record.
   * @returns {Promise<import('../models/Model.js').Model|undefined>}
   */
  async first() {
    this.#logger.debug('Query', `Executing first().`);
    const results = await this.fetch();
    return results[0];
  }

  /**
   * Executes the query and fetches all matching records.
   * @returns {Promise<Array<import('../models/Model.js').Model>>}
   */
  async fetch() {
    this.#logger.debug('Query', `Executing fetch() with conditions:`, this.#conditionGroups);
    
    const rawDataArray = await this.#collection._executeQuery(this.#conditionGroups);
    this.#logger.debug('Query', `fetch() received ${rawDataArray.length} raw records from collection.`);

    return this.#collection._toModelArray(rawDataArray);
  }

  /**
   * Subscribes to the query results.
   * @param {function(Array<import('../models/Model.js').Model>): void} callback
   * @returns {Function} An unsubscribe function.
   */
  observe(callback) {
    this.#logger.debug('Query', `observe() called. Setting up subscription.`);
    
    this.fetch().then(initialResults => {
      this.#logger.debug('Query', `Observer initial fetch complete. Notifying callback.`);
      callback(initialResults);
    }).catch(error => {
      this.#logger.error('Query', 'Error during initial fetch for observe():', error);
    });

    const handleChange = (change) => {
      if (change.collectionName === this.#collection.name) {
        this.#logger.debug('Query', `Observer detected a relevant change. Re-fetching...`, change);
        this.fetch().then(newResults => {
          this.#logger.debug('Query', `Observer re-fetch complete. Notifying callback.`);
          callback(newResults);
        }).catch(error => {
          this.#logger.error('Query', 'Error during re-fetch for observe():', error);
        });
      }
    };

    const emitter = this.#database.emitter;
    if (!emitter) {
        this.#logger.error('Query', 'Could not find emitter to observe changes.');
        return () => {};
    }

    return emitter.on('change', handleChange);
  }
}
