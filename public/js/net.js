// WebSocket client with server-clock sync.

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.connected = false;
    this.id = null;
    this.offset = 0; // serverTime ~= Date.now() + offset
    this.rtt = null;
    this.samples = [];
    this.syncTimer = null;
    this._connecting = null;
  }

  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
    return this;
  }

  _emit(type, data) {
    for (const fn of this.handlers[type] ?? []) fn(data);
  }

  /** Connect (or reuse the connection). Resolves once the server said hello. */
  connect() {
    if (this.connected) return Promise.resolve();
    if (this._connecting) return this._connecting;

    this._connecting = new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        if (location.protocol === "file:") throw new Error("opened from file");
        const proto = location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${proto}://${location.host}`);
      } catch (e) {
        this._connecting = null;
        reject(e);
        return;
      }
      this.ws = ws;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this._connecting = null;
          try {
            ws.close();
          } catch {}
          reject(new Error("timeout"));
        }
      }, 4000);

      ws.onmessage = (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (m.t === "welcome") {
          this.connected = true;
          this.id = m.id;
          this.offset = m.serverTime - Date.now();
          this._startSync();
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this._connecting = null;
            resolve();
          }
        } else if (m.t === "pong") {
          this._onPong(m);
          return;
        }
        this._emit(m.t, m);
      };
      ws.onclose = () => {
        clearInterval(this.syncTimer);
        const was = this.connected;
        this.connected = false;
        this._connecting = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("closed"));
        }
        if (was) this._emit("close", {});
      };
      ws.onerror = () => {};
    });
    return this._connecting;
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  _startSync() {
    clearInterval(this.syncTimer);
    this.samples = [];
    let n = 0;
    const ping = () => this.send({ t: "ping", c: Date.now() });
    const burst = setInterval(() => {
      ping();
      if (++n >= 6) clearInterval(burst);
    }, 120);
    this.syncTimer = setInterval(ping, 5000);
  }

  _onPong(m) {
    const now = Date.now();
    const rtt = now - m.c;
    if (rtt < 0) return;
    // assume symmetric latency: server stamped `s` at (c + rtt/2)
    const offset = m.s + rtt / 2 - now;
    this.samples.push({ rtt, offset });
    if (this.samples.length > 8) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset; // lowest-RTT sample is the most trustworthy
    this.rtt = best.rtt;
    this._emit("latency", { rtt: this.rtt });
  }

  toLocal(serverTs) {
    return serverTs - this.offset;
  }
}
