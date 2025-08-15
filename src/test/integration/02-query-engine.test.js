// hydrodb/test/integration/02-query-engine.test.js

import 'fake-indexeddb/auto';

import { Database } from '../../src/core/Database.js';
import { Schema } from '../../src/core/Schema.js';

// A schema with both indexed and non-indexed fields.
const queryTestSchema = new Schema({
  version: 1,
  collections: {
    products: {
      fields: {
        name: 'string',
        category: 'string', // This field will be indexed.
        status: 'string',   // This field will NOT be indexed.
        stock: 'number',
      },
      indexes: ['category'], // We explicitly create an index on 'category'.
    },
  },
});

describe('Integration: Query Engine', () => {
  let db;
  let productsCollection;

  // Before all tests in this suite, set up the database and seed it with data.
  beforeAll(async () => {
    const dbName = `query_test_db_${Date.now()}`;
    db = new Database({ schema: queryTestSchema, dbName });
    await db.connect();
    productsCollection = db.getCollection('products');

    // Seed the database with a variety of products.
    await Promise.all([
      productsCollection.create({ name: 'Laptop', category: 'electronics', status: 'published', stock: 10 }),
      productsCollection.create({ name: 'Mouse', category: 'electronics', status: 'published', stock: 150 }),
      productsCollection.create({ name: 'Desk Chair', category: 'furniture', status: 'published', stock: 50 }),
      productsCollection.create({ name: 'Book', category: 'books', status: 'draft', stock: 200 }),
      productsCollection.create({ name: 'Keyboard', category: 'electronics', status: 'archived', stock: 0 }),
    ]);
  });

  // After all tests, disconnect.
  afterAll(() => {
    db.disconnect();
  });

  it('should return all records when no "where" clause is used', async () => {
    const allProducts = await productsCollection.query().fetch();
    // We created 5 products in the beforeAll hook.
    expect(allProducts.length).toBe(5);
  });

  it('should correctly filter records using a "where" clause on an INDEXED field', async () => {
    // This query should be fast and use the 'category' index.
    const electronics = await productsCollection.query().where('category', 'electronics').fetch();

    expect(electronics.length).toBe(3);
    // Check that the names are correct to be sure we got the right items.
    const names = electronics.map(p => p.name).sort();
    expect(names).toEqual(['Keyboard', 'Laptop', 'Mouse']);
  });

  it('should correctly filter records using a "where" clause on a NON-INDEXED field', async () => {
    // This query will use the slower fallback method (scan all records).
    const publishedProducts = await productsCollection.query().where('status', 'published').fetch();

    expect(publishedProducts.length).toBe(3);
    const names = publishedProducts.map(p => p.name).sort();
    expect(names).toEqual(['Desk Chair', 'Laptop', 'Mouse']);
  });

  it('should return an empty array if no records match the query', async () => {
    const nonExistent = await productsCollection.query().where('category', 'toys').fetch();
    expect(nonExistent.length).toBe(0);
  });

  it('should handle multiple "where" clauses (fallback to non-indexed scan)', async () => {
    // Our current implementation falls back to a full scan for multiple conditions.
    const query = productsCollection.query()
      .where('category', 'electronics')
      .where('status', 'published');

    const results = await query.fetch();

    expect(results.length).toBe(2);
    const names = results.map(p => p.name).sort();
    expect(names).toEqual(['Laptop', 'Mouse']);
  });

  it('should return the first matching record using .first()', async () => {
    // The order is not guaranteed, but it should return one of the matching items.
    const firstElectronic = await productsCollection.query().where('category', 'electronics').first();

    expect(firstElectronic).toBeDefined();
    expect(firstElectronic.category).toBe('electronics');
  });

  it('should return undefined from .first() if no records match', async () => {
    const noResult = await productsCollection.query().where('category', 'apparel').first();
    expect(noResult).toBeUndefined();
  });
});


