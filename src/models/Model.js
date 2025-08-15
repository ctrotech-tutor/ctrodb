// hydrodb/src/models/Model.js

export class Model {
  #data;
  #collection;
  #database;
  #logger;

  constructor(initialData, collection, database, logger) {
    if (!initialData) throw new Error('Model requires initial data.');
    if (!collection) throw new Error('Model requires a reference to its parent collection.');
    if (!database) throw new Error('Model requires a reference to the database for relations.');
    if (!logger) throw new Error('Model requires a logger instance.');

    this.#data = initialData;
    this.#collection = collection;
    this.#database = database;
    this.#logger = logger;

    this.#createRelationGetters();

    return new Proxy(this, {
      get(target, prop) {
        // If the property exists on the original target (like 'update', 'delete', 'id')
        if (prop in target) {
          const value = target[prop];
          // **THE FIX IS HERE**: If the property is a function, return it bound
          // to the original target. This ensures 'this' is correct inside the function.
          if (typeof value === 'function') {
            return value.bind(target);
          }
          return value;
        }
        // Otherwise, return the property from the raw data.
        return target.#data[prop];
      },
      set(target, prop, value) {
        target.#logger.warn('Model', `Directly setting '${String(prop)}' is not allowed. Use the .update() method.`);
        return false;
      }
    });
  }

  #createRelationGetters() {
    const collectionSchema = this.#collection._getCollectionSchema();
    const relations = collectionSchema?.relations;
    if (!relations) return;

    for (const relationName in relations) {
      const relation = relations[relationName];
      Object.defineProperty(this, relationName, {
        get: () => {
          this.#logger.debug('Model', `Accessed relation '${relationName}' on model with id ${this.id}.`);
          const relatedCollection = this.#database.getCollection(relation.collection);
          if (relation.type === 'has_many') {
            return relatedCollection.query().where(relation.foreignKey, this.id);
          }
          if (relation.type === 'belongs_to') {
            const foreignKeyValue = this.#data[relation.foreignKey];
            return relatedCollection.query().where('id', foreignKeyValue);
          }
          return undefined;
        },
        configurable: true,
        enumerable: true
      });
    }
  }

  get id() {
    return this.#data.id;
  }

  async update(dataToUpdate) {
    this.#logger.debug('Model', `update() called on model with id ${this.id}.`, dataToUpdate);
    return this.#collection.update(this.id, dataToUpdate);
  }

  async delete() {
    this.#logger.debug('Model', `delete() called on model with id ${this.id}.`);
    await this.#collection.delete(this.id);
    Object.freeze(this);
  }

  toJSON() {
    return { ...this.#data };
  }
}
