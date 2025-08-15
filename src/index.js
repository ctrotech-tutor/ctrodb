// hydrodb/src/index.js

/**
 * @file This is the main entry point for the HydroDB library.
 * It exports the primary, public-facing classes and utilities that developers will use.
 * By controlling what is exported here, we define the public API of the library.
 */

import { Database } from './core/Database.js';
import { Schema } from './core/Schema.js';
import { LogLevel } from './core/Logger.js'; // Import LogLevel

// Export the classes and utilities that developers will need to interact with.
// We do NOT export internal classes like IndexedDBAdapter or Collection,
// as they are meant to be used internally by the Database class.
export {
  Database,
  Schema,
  LogLevel, // Export LogLevel so it can be used in the database config.
};
