// hydrodb/test/setup/jest.setup.js

/**
 * @file This setup file is automatically run by Jest before any tests are executed.
 * Its primary purpose is to configure the global environment for all test suites.
 */

// Import the fake-indexeddb library with the 'auto' option.
// This automatically replaces the global `window.indexedDB` and related objects
// with a high-performance, in-memory mock implementation.
// This allows all of our adapter code to run outside of a real browser environment.
import 'fake-indexeddb/auto';

// You could add other global setup here in the future, such as:
// - Setting up timers with jest.useFakeTimers()
// - Extending expect() with custom matchers
// - Silencing console.log messages during tests to keep the output clean

console.log('Jest setup complete: IndexedDB has been mocked.');


