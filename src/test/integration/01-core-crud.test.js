// hydrodb/test/integration/01-core-crud.test.js

// This import automatically mocks IndexedDB in the test environment.
import 'fake-indexeddb/auto';

import { Database } from '../../src/core/Database.js';
import { Schema } from '../../src/core/Schema.js';
import { Model } from '../../src/models/Model.js';

// A standard schema for all CRUD tests.
const testSchema = new Schema({
  version: 1,
  collections: {
    users: {
      fields: {
        name: 'string',
        age: 'number',
      },
    },
  },
});

describe('Integration: Core CRUD Operations', () => {
  let db;

  // Before each test, create a fresh database instance and connect to it.
  beforeEach(async () => {
    // Use a unique database name for each test to ensure isolation.
    const dbName = `test_db_${Date.now()}_${Math.random()}`;
    db = new Database({ schema: testSchema, dbName });
    await db.connect();
  });

  // After each test, disconnect and clean up.
  afterEach(() => {
    db.disconnect();
  });

  it('should create a new record and return a Model instance', async () => {
    const usersCollection = db.getCollection('users');
    const userData = { name: 'Alice', age: 30 };

    const createdUser = await usersCollection.create(userData);

    // 1. Check that the returned object is a Model instance.
    expect(createdUser).toBeInstanceOf(Model);
    // 2. Check that the data is correct.
    expect(createdUser.name).toBe('Alice');
    expect(createdUser.age).toBe(30);
    // 3. Check that an ID was auto-generated.
    expect(createdUser.id).toBeDefined();
    expect(createdUser.id).not.toBeNull();
  });

  it('should find an existing record by its ID', async () => {
    const usersCollection = db.getCollection('users');
    const createdUser = await usersCollection.create({ name: 'Bob', age: 40 });

    const foundUser = await usersCollection.find(createdUser.id);

    expect(foundUser).toBeInstanceOf(Model);
    expect(foundUser.id).toBe(createdUser.id);
    expect(foundUser.name).toBe('Bob');
  });

  it('should return undefined when finding a non-existent record', async () => {
    const usersCollection = db.getCollection('users');
    const nonExistentId = 999;

    const foundUser = await usersCollection.find(nonExistentId);

    expect(foundUser).toBeUndefined();
  });

  it('should update an existing record using the collection method', async () => {
    const usersCollection = db.getCollection('users');
    const createdUser = await usersCollection.create({ name: 'Charlie', age: 25 });

    const updatedUser = await usersCollection.update(createdUser.id, { age: 26 });

    expect(updatedUser.age).toBe(26);
    // Ensure other data was not lost.
    expect(updatedUser.name).toBe('Charlie');

    // Verify the change was persisted.
    const refetchedUser = await usersCollection.find(createdUser.id);
    expect(refetchedUser.age).toBe(26);
  });

  it('should update an existing record using the model method', async () => {
    const usersCollection = db.getCollection('users');
    const userModel = await usersCollection.create({ name: 'Diana', age: 50 });

    // Use the .update() method directly on the model instance.
    const updatedUserModel = await userModel.update({ age: 51 });

    expect(updatedUserModel.age).toBe(51);
    expect(updatedUserModel.name).toBe('Diana');

    const refetchedUser = await usersCollection.find(userModel.id);
    expect(refetchedUser.age).toBe(51);
  });

  it('should delete a record using the collection method', async () => {
    const usersCollection = db.getCollection('users');
    const createdUser = await usersCollection.create({ name: 'Eve', age: 35 });

    // Ensure it exists first.
    expect(await usersCollection.find(createdUser.id)).toBeDefined();

    await usersCollection.delete(createdUser.id);

    // Verify it no longer exists.
    const foundUser = await usersCollection.find(createdUser.id);
    expect(foundUser).toBeUndefined();
  });

  it('should delete a record using the model method', async () => {
    const usersCollection = db.getCollection('users');
    const userModel = await usersCollection.create({ name: 'Frank', age: 45 });

    expect(await usersCollection.find(userModel.id)).toBeDefined();

    // Use the .delete() method directly on the model instance.
    await userModel.delete();

    const foundUser = await usersCollection.find(userModel.id);
    expect(foundUser).toBeUndefined();
  });
});


