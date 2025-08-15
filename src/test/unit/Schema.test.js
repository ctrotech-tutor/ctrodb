

// hydrodb/test/unit/Schema.test.js

import { Schema } from '../../src/core/Schema.js';

// 'describe' groups related tests together into a test suite.
describe('Schema', () => {

  // A valid schema configuration to be reused in tests.
  const validConfig = {
    version: 1,
    collections: {
      posts: {
        fields: {
          title: 'string',
          body: 'string',
        },
        indexes: ['title'],
      },
    },
  };

  // 'it' or 'test' defines an individual test case.
  it('should correctly initialize with a valid configuration', () => {
    // 'expect' is used to make an assertion.
    // The '.not.toThrow()' assertion checks that no error is thrown.
    expect(() => new Schema(validConfig)).not.toThrow();

    const schema = new Schema(validConfig);
    // '.toEqual()' is used for deep equality checks on objects.
    expect(schema.version).toBe(1);
    expect(schema.collections).toEqual(validConfig.collections);
  });

  it('should throw an error if no configuration is provided', () => {
    // We expect this to throw an error. The function passed to 'expect'
    // must be wrapped in an arrow function.
    expect(() => new Schema()).toThrow('Schema configuration must be provided as an object.');
  });

  it('should throw an error for an invalid version number', () => {
    // Test case for a non-integer version.
    const configWithFloatVersion = { ...validConfig, version: 1.5 };
    expect(() => new Schema(configWithFloatVersion)).toThrow('Schema version must be a positive integer.');

    // Test case for a zero version.
    const configWithZeroVersion = { ...validConfig, version: 0 };
    expect(() => new Schema(configWithZeroVersion)).toThrow('Schema version must be a positive integer.');

    // Test case for a non-numeric version.
    const configWithInvalidVersion = { ...validConfig, version: '1' };
    expect(() => new Schema(configWithInvalidVersion)).toThrow('Schema version must be a positive integer.');
  });

  it('should throw an error if collections are missing or empty', () => {
    // Test case for missing collections property.
    const configWithoutCollections = { version: 1 };
    expect(() => new Schema(configWithoutCollections)).toThrow('Schema must define at least one collection.');

    // Test case for an empty collections object.
    const configWithEmptyCollections = { version: 1, collections: {} };
    expect(() => new Schema(configWithEmptyCollections)).toThrow('Schema must define at least one collection.');
  });

  it('should throw an error if a collection is missing a fields object', () => {
    const configWithInvalidCollection = {
      version: 1,
      collections: {
        posts: {
          // 'fields' property is missing
        },
      },
    };
    expect(() => new Schema(configWithInvalidCollection)).toThrow("Collection 'posts' must define a 'fields' object.");
  });

});
