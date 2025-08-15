
// hydrodb/test/unit/Emitter.test.js

import { Emitter } from '../../src/core/Emitter.js';

describe('Emitter', () => {
  let emitter;

  // 'beforeEach' is a setup function that runs before each test in this suite.
  // This ensures each test starts with a fresh, clean Emitter instance.
  beforeEach(() => {
    emitter = new Emitter();
  });

  it('should call a subscribed listener when an event is emitted', () => {
    // jest.fn() creates a "mock function" that we can track.
    const listener = jest.fn();
    const eventName = 'test-event';

    emitter.on(eventName, listener);
    emitter.emit(eventName);

    // .toHaveBeenCalled() checks if the mock function was called at least once.
    expect(listener).toHaveBeenCalled();
  });

  it('should call the listener with the correct data payload', () => {
    const listener = jest.fn();
    const eventName = 'data-event';
    const payload = { id: 1, message: 'hello' };

    emitter.on(eventName, listener);
    emitter.emit(eventName, payload);

    // .toHaveBeenCalledWith() checks if the function was called with specific arguments.
    expect(listener).toHaveBeenCalledWith(payload);
  });

  it('should not call a listener after it has been unsubscribed with .off()', () => {
    const listener = jest.fn();
    const eventName = 'unsubscribe-event';

    emitter.on(eventName, listener);
    emitter.off(eventName, listener);
    emitter.emit(eventName);

    // .not.toHaveBeenCalled() asserts that the mock function was never called.
    expect(listener).not.toHaveBeenCalled();
  });

  it('should unsubscribe a listener using the returned function from .on()', () => {
    const listener = jest.fn();
    const eventName = 'unsubscribe-return-event';

    const unsubscribe = emitter.on(eventName, listener);
    unsubscribe(); // Call the returned unsubscribe function.
    emitter.emit(eventName);

    expect(listener).not.toHaveBeenCalled();
  });

  it('should call all subscribed listeners for an event', () => {
    const listener1 = jest.fn();
    const listener2 = jest.fn();
    const eventName = 'multiple-listeners-event';

    emitter.on(eventName, listener1);
    emitter.on(eventName, listener2);
    emitter.emit(eventName);

    expect(listener1).toHaveBeenCalled();
    expect(listener2).toHaveBeenCalled();
  });

  it('should not be affected by a listener unsubscribing itself during an emit cycle', () => {
    const listener1 = jest.fn();
    const listener2 = jest.fn(() => {
      // This listener unsubscribes itself when called.
      emitter.off('self-remove-event', listener2);
    });
    const listener3 = jest.fn();
    const eventName = 'self-remove-event';

    emitter.on(eventName, listener1);
    emitter.on(eventName, listener2);
    emitter.on(eventName, listener3);

    emitter.emit(eventName);

    // All three should have been called, even though one removed itself mid-cycle.
    // This proves our "safe iteration" logic is working.
    expect(listener1).toHaveBeenCalled();
    expect(listener2).toHaveBeenCalled();
    expect(listener3).toHaveBeenCalled();

    // Check that listener2 was actually removed for the next emit.
    emitter.emit(eventName);
    expect(listener2).toHaveBeenCalledTimes(1); // Should not have been called a second time.
  });

  it('should not crash if one listener throws an error', () => {
    const errorListener = () => {
      throw new Error('Test error');
    };
    const normalListener = jest.fn();
    const eventName = 'error-event';

    emitter.on(eventName, errorListener);
    emitter.on(eventName, normalListener);

    // We expect the emit itself not to throw an error, because it's caught internally.
    expect(() => emitter.emit(eventName)).not.toThrow();

    // We expect the other listener to have still been called.
    expect(normalListener).toHaveBeenCalled();
  });
});

