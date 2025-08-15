// hydrodb/src/core/Emitter.js

/**
 * @class Emitter
 * @description A simple, generic, in-memory event emitter (publish-subscribe) system.
 * This class is used to decouple different parts of the database, allowing them
 * to communicate without having direct references to each other.
 */
export class Emitter {
  /**
   * A map to store event listeners. The key is the event name,
   * and the value is a Set of callback functions.
   * @private
   * @type {Map<string, Set<Function>>}
   */
  #listeners = new Map();

  /**
   * Subscribes a callback function to an event.
   *
   * @param {string} eventName - The name of the event to listen for.
   * @param {Function} callback - The function to call when the event is emitted.
   * @returns {Function} A function that, when called, will unsubscribe the listener.
   */
  on(eventName, callback) {
    if (!this.#listeners.has(eventName)) {
      this.#listeners.set(eventName, new Set());
    }
    const listeners = this.#listeners.get(eventName);
    listeners.add(callback);

    // Return an unsubscribe function for easy cleanup.
    return () => this.off(eventName, callback);
  }

  /**
   * Unsubscribes a callback function from an event.
   *
   * @param {string} eventName - The name of the event to unsubscribe from.
   * @param {Function} callback - The specific callback function to remove.
   */
  off(eventName, callback) {
    if (this.#listeners.has(eventName)) {
      const listeners = this.#listeners.get(eventName);
      listeners.delete(callback);

      // Clean up the Map entry if no listeners remain for this event.
      if (listeners.size === 0) {
        this.#listeners.delete(eventName);
      }
    }
  }

  /**
   * Emits an event, calling all subscribed listeners with the provided data.
   *
   * @param {string} eventName - The name of the event to emit.
   * @param {any} [data] - The data to pass to each listener.
   */
  emit(eventName, data) {
    if (this.#listeners.has(eventName)) {
      // Iterate over a copy of the Set to prevent issues if a listener
      // unsubscribes itself during the emit cycle.
      const listeners = new Set(this.#listeners.get(eventName));
      listeners.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in event listener for '${eventName}':`, error);
        }
      });
    }
  }
}


