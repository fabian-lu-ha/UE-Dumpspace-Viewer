class EventBus {
  constructor() {
    this.handlers = new Map();
  }

  on(eventName, handler) {
    if (!this.handlers.has(eventName)) {
      this.handlers.set(eventName, new Set());
    }

    this.handlers.get(eventName).add(handler);
    return () => this.off(eventName, handler);
  }

  off(eventName, handler) {
    const handlers = this.handlers.get(eventName);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  emit(eventName, payload) {
    const handlers = this.handlers.get(eventName);
    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      handler(payload);
    }
  }
}

module.exports = {
  EventBus
};
