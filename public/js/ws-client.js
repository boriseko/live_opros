/**
 * WebSocket client wrapper with auto-reconnect and event emitter pattern.
 *
 * Usage:
 *   const ws = new WsClient('/ws/participant?sessionId=1');
 *   ws.on('question:show', (payload) => { ... });
 *   ws.send('answer:submit', { questionId: 1, answer: 'A' });
 */
class WsClient {
  constructor(path) {
    this.path = path;
    this.ws = null;
    this.listeners = {};
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 15000;
    this.queue = []; // Messages queued while disconnected
    this.intentionallyClosed = false;
    this.connect();
  }

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}${this.path}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.emit('_connected', {});

      // Flush queued messages (max 20, drop old stale ones)
      if (this.queue.length > 20) {
        this.queue = this.queue.slice(-20);
      }
      while (this.queue.length > 0) {
        const msg = this.queue.shift();
        this.ws.send(msg);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const { type, payload } = JSON.parse(event.data);
        this.emit(type, payload);
      } catch (e) {
        console.error('WS parse error:', e);
      }
    };

    this.ws.onclose = () => {
      this.emit('_disconnected', {});
      if (!this.intentionallyClosed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  scheduleReconnect() {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    setTimeout(() => {
      if (!this.intentionallyClosed) {
        this.connect();
      }
    }, delay);
  }

  send(type, payload) {
    const msg = JSON.stringify({ type, payload });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else {
      this.queue.push(msg);
    }
  }

  on(type, callback) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(callback);
  }

  off(type, callback) {
    if (!this.listeners[type]) return;
    this.listeners[type] = this.listeners[type].filter((cb) => cb !== callback);
  }

  emit(type, payload) {
    const handlers = this.listeners[type];
    if (handlers) {
      handlers.forEach((cb) => cb(payload));
    }
    // Also emit wildcard
    const wildcardHandlers = this.listeners['*'];
    if (wildcardHandlers) {
      wildcardHandlers.forEach((cb) => cb(type, payload));
    }
  }

  close() {
    this.intentionallyClosed = true;
    if (this.ws) this.ws.close();
  }

  get connected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}
