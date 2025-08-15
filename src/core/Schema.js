// hydrodb/src/core/Schema.js

/**
 * @class Schema
 * @description Defines the structure of the HydroDB database, including version, collections, and their fields.
 * This class is the blueprint used to initialize and migrate the database.
 */
export class Schema {
  /**
   * @constructor
   * @param {object} config - The schema configuration object.
   * @param {number} config.version - The version of the schema. This must be an integer and should be incremented
   *   for each new version of the schema to trigger a migration.
   * @param {object} config.collections - An object where each key is a collection name.
   * @param {object} config.collections.<collectionName> - The configuration for a specific collection.
   * @param {object} config.collections.<collectionName>.fields - An object defining the fields for records in this collection.
   * @param {string} config.collections.<collectionName>.fields.<fieldName> - The data type of the field (e.g., 'string', 'number', 'boolean', 'object').
   * @param {Array<string>} [config.collections.<collectionName>.indexes] - An optional array of field names to create indexes on for faster queries.
   * @param {object} [config.collections.<collectionName>.relations] - An optional object defining relationships to other collections.
   */
  constructor(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('Schema configuration must be provided as an object.');
    }

    if (typeof config.version !== 'number' || !Number.isInteger(config.version) || config.version < 1) {
      throw new Error('Schema version must be a positive integer.');
    }

    if (!config.collections || typeof config.collections !== 'object' || Object.keys(config.collections).length === 0) {
      throw new Error('Schema must define at least one collection.');
    }

    this.version = config.version;
    this.collections = config.collections;

    // Validate collections structure
    for (const collectionName in this.collections) {
      const collection = this.collections[collectionName];
      if (!collection.fields || typeof collection.fields !== 'object') {
        throw new Error(`Collection '${collectionName}' must define a 'fields' object.`);
      }
    }
  }
}
