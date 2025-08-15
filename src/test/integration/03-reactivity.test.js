// hydrodb/test/integration/03-reactivity.test.js

import 'fake-indexeddb/auto';

import { Database } from '../../src/core/Database.js';
import { Schema } from '../../src/core/Schema.js';

const reactivityTestSchema = new Schema({
  version: 1,
  collections: {
    tasks: {
      fields: {
        title: 'string',
        completed: 'boolean',
      },
      indexes: ['completed'],
    },
  },
});

describe('Integration: Reactivity System', () => {
  let db;
  let tasksCollection;

  beforeEach(async () => {
    const dbName = `reactivity_test_db_${Date.now()}_${Math.random()}`;
    db = new Database({ schema: reactivityTestSchema, dbName });
    await db.connect();
    tasksCollection = db.getCollection('tasks');
  });

  afterEach(() => {
    db.disconnect();
  });

  it('observe() should call the callback immediately with initial results', (done) => {
    // This test uses the 'done' callback, a Jest feature for handling async code
    // that isn't based on promises.

    const observerCallback = jest.fn((tasks) => {
      // The first time this is called, the tasks array should be empty.
      expect(tasks).toEqual([]);
      done(); // 'done()' tells Jest the test is complete.
    });

    tasksCollection.query().observe(observerCallback);
  });

  it('observe() callback should be triggered after a new record is created', (done) => {
    const resultsStack = [];
    const observerCallback = jest.fn((tasks) => {
      resultsStack.push(tasks);

      if (resultsStack.length === 2) {
        // The first result should be an empty array.
        expect(resultsStack[0]).toEqual([]);
        // The second result should contain the new task.
        expect(resultsStack[1].length).toBe(1);
        expect(resultsStack[1][0].title).toBe('New Task');
        done();
      }
    });

    tasksCollection.query().observe(observerCallback);

    // After setting up the observer, create a new task.
    tasksCollection.create({ title: 'New Task', completed: false });
  });

  it('observe() callback should be triggered after a record is updated', (done) => {
    const resultsStack = [];
    const observerCallback = jest.fn((tasks) => {
      resultsStack.push(tasks);

      if (resultsStack.length === 3) {
        // 1. Initial: [task]
        // 2. After update: [updated task]
        // 3. After another update: [another updated task]
        // We will check the final state.
        const finalTask = resultsStack[2][0];
        expect(finalTask.completed).toBe(true);
        done();
      }
    });

    // Create an initial task.
    tasksCollection.create({ title: 'Update Me', completed: false }).then(task => {
      // Now set up the observer. It will be called once for the initial state.
      tasksCollection.query().where('id', task.id).observe(observerCallback);
      // Then, update the task.
      task.update({ completed: true });
    });
  });

  it('observe() callback should be triggered after a record is deleted', (done) => {
    const resultsStack = [];
    const observerCallback = jest.fn((tasks) => {
      resultsStack.push(tasks);

      if (resultsStack.length === 2) {
        // First result: [task]
        expect(resultsStack[0].length).toBe(1);
        // Second result (after delete): []
        expect(resultsStack[1].length).toBe(0);
        done();
      }
    });

    tasksCollection.create({ title: 'Delete Me', completed: false }).then(task => {
      // Observe the query for this specific task.
      tasksCollection.query().where('id', task.id).observe(observerCallback);
      // Then, delete the task.
      task.delete();
    });
  });

  it('should stop triggering the callback after the unsubscribe function is called', (done) => {
    const observerCallback = jest.fn();

    // Set up the observer and immediately get the unsubscribe function.
    const unsubscribe = tasksCollection.query().observe(observerCallback);

    // Unsubscribe right away.
    unsubscribe();

    // Create a new task.
    tasksCollection.create({ title: 'Should Not Be Seen', completed: false }).then(() => {
      // The callback should have been called only once for the initial empty state.
      expect(observerCallback).toHaveBeenCalledTimes(1);
      done();
    });
  });
});


