/** Stands in for the browser's EventSource so that tests can send events by hand. */
export class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeEventSource.CONNECTING;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  send(type, data, id = '') {
    for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data), lastEventId: String(id) });
  }

  node(id, nodeId, status, message = '') {
    this.send('node', { runId: 'r', nodeId, status, message, ts: 1 }, id);
  }

  heartbeat(intervalMs) {
    this.send('heartbeat', { intervalMs });
  }

  fail(readyState) {
    this.readyState = readyState;
    this.onerror?.();
  }
}
