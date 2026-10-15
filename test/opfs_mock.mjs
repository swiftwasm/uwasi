class FileState {
  constructor(path) {
    this.path = path;
    this.visible = new Uint8Array(0);
    this.durable = new Uint8Array(0);
    this.lock = null;
  }
}

class DirState {
  constructor(path) {
    this.path = path;
    this.children = new Map();
  }
}

function byteView(buffer) {
  return ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
}

class MockSyncAccessHandle {
  #state;
  #store;
  #connection;
  #cursor = 0;
  #closed = false;

  constructor(state, connection, store) {
    this.#state = state;
    this.#connection = connection;
    this.#store = store;
  }

  #ensureOpen() {
    if (this.#closed || !this.#connection.alive) {
      throw new DOMException(
        "The access handle is closed",
        "InvalidStateError",
      );
    }
  }

  read(buffer, { at = this.#cursor } = {}) {
    this.#ensureOpen();
    if (!Number.isInteger(at) || at < 0) {
      throw new TypeError(`invalid read offset: ${at}`);
    }
    const fault = this.#store._fireFault("read", this.#state.path);
    const view = byteView(buffer);
    const count = Math.min(
      view.byteLength,
      Math.max(0, this.#state.visible.byteLength - at),
      fault?.short ?? Infinity,
    );
    view.set(this.#state.visible.subarray(at, at + count));
    this.#cursor = at + count;
    return count;
  }

  write(buffer, { at = this.#cursor } = {}) {
    this.#ensureOpen();
    if (!Number.isInteger(at) || at < 0) {
      throw new TypeError(`invalid write offset: ${at}`);
    }
    const fault = this.#store._fireFault("write", this.#state.path);
    const data = byteView(buffer).subarray(0, fault?.short);
    const end = at + data.byteLength;
    if (data.byteLength > 0) {
      if (end > this.#state.visible.byteLength) {
        const grown = new Uint8Array(end);
        grown.set(this.#state.visible);
        this.#state.visible = grown;
      }
      this.#state.visible.set(data, at);
    }
    this.#cursor = end;
    return data.byteLength;
  }

  truncate(newSize) {
    this.#ensureOpen();
    if (!Number.isInteger(newSize) || newSize < 0) {
      throw new TypeError(`invalid truncate size: ${newSize}`);
    }
    this.#store._fireFault("truncate", this.#state.path);
    const next = new Uint8Array(newSize);
    next.set(this.#state.visible.subarray(0, newSize));
    this.#state.visible = next;
    this.#cursor = Math.min(this.#cursor, newSize);
  }

  getSize() {
    this.#ensureOpen();
    this.#store._fireFault("getSize", this.#state.path);
    return this.#state.visible.byteLength;
  }

  flush() {
    this.#ensureOpen();
    this.#store._fireFault("flush", this.#state.path);
    this.#state.durable = this.#state.visible.slice();
  }

  close() {
    if (this.#closed) return;
    this.#ensureOpen();
    if (this.#store.closeFlushes) {
      this.#state.durable = this.#state.visible.slice();
    }
    this.#closed = true;
    this.#state.lock = null;
  }
}

class MockFileHandle {
  kind = "file";

  constructor(state, connection, store) {
    this.name = state.path.split("/").pop();
    this._state = state;
    this._connection = connection;
    this._store = store;
  }

  async createSyncAccessHandle() {
    if (!this._connection.alive) {
      throw new DOMException(
        "The worker owning this handle died",
        "InvalidStateError",
      );
    }
    if (this._state.lock) {
      throw new DOMException(
        `Access handle already open on ${this._state.path}`,
        "NoModificationAllowedError",
      );
    }
    this._store._fireFault("createSyncAccessHandle", this._state.path);
    const handle = new MockSyncAccessHandle(
      this._state,
      this._connection,
      this._store,
    );
    this._state.lock = handle;
    return handle;
  }
}

class MockDirectoryHandle {
  kind = "directory";

  constructor(state, connection, store) {
    this.name = state.path.split("/").pop();
    this._state = state;
    this._connection = connection;
    this._store = store;
  }

  #ensureAlive() {
    if (!this._connection.alive) {
      throw new DOMException(
        "The worker owning this handle died",
        "InvalidStateError",
      );
    }
  }

  #wrap(state) {
    return state instanceof DirState
      ? new MockDirectoryHandle(state, this._connection, this._store)
      : new MockFileHandle(state, this._connection, this._store);
  }

  async getFileHandle(name, options = {}) {
    this.#ensureAlive();
    const path = `${this._state.path}/${name}`;
    this._store._fireFault("getFileHandle", path);
    let state = this._state.children.get(name);
    if (state instanceof DirState) {
      throw new DOMException(`${name} is a directory`, "TypeMismatchError");
    }
    if (!state) {
      if (!options.create) {
        throw new DOMException(`No file named ${name}`, "NotFoundError");
      }
      state = new FileState(path);
      this._state.children.set(name, state);
    }
    return this.#wrap(state);
  }

  async getDirectoryHandle(name, options = {}) {
    this.#ensureAlive();
    let state = this._state.children.get(name);
    if (state instanceof FileState) {
      throw new DOMException(`${name} is a file`, "TypeMismatchError");
    }
    if (!state) {
      if (!options.create) {
        throw new DOMException(`No directory named ${name}`, "NotFoundError");
      }
      state = new DirState(`${this._state.path}/${name}`);
      this._state.children.set(name, state);
    }
    return this.#wrap(state);
  }

  async removeEntry(name, options = {}) {
    this.#ensureAlive();
    this._store._fireFault("removeEntry", `${this._state.path}/${name}`);
    const child = this._state.children.get(name);
    if (!child) {
      throw new DOMException(`No entry named ${name}`, "NotFoundError");
    }
    if (child instanceof FileState && child.lock) {
      throw new DOMException(
        `${name} has an open access handle`,
        "NoModificationAllowedError",
      );
    }
    if (
      child instanceof DirState &&
      child.children.size > 0 &&
      !options.recursive
    ) {
      throw new DOMException(
        `${name} is not empty`,
        "InvalidModificationError",
      );
    }
    this._state.children.delete(name);
  }

  async *entries() {
    this.#ensureAlive();
    for (const [name, state] of this._state.children) {
      this.#ensureAlive();
      yield [name, this.#wrap(state)];
    }
  }
}

function matches(match, path, op) {
  if (match === undefined) return true;
  if (typeof match === "string") return path.includes(match);
  if (match instanceof RegExp) {
    match.lastIndex = 0;
    return match.test(path);
  }
  return Boolean(match(path, op));
}

export class MockOPFS {
  constructor({ closeFlushes = true } = {}) {
    this.closeFlushes = closeFlushes;
    this._rootState = new DirState("");
    this._connection = { alive: true };
    this._faults = [];
  }

  injectFault({
    op,
    match,
    nth = 1,
    times = 1,
    error = "QuotaExceededError",
    short,
  }) {
    if (
      ![
        "read",
        "write",
        "truncate",
        "getSize",
        "flush",
        "getFileHandle",
        "createSyncAccessHandle",
        "removeEntry",
      ].includes(op)
    ) {
      throw new TypeError(`unknown fault op: ${op}`);
    }
    const fault = { op, match, nth, times, error, short, matched: 0, fired: 0 };
    this._faults.push(fault);
    return fault;
  }

  clearFaults() {
    this._faults = [];
  }

  _fireFault(op, path) {
    let short = null;
    for (const fault of this._faults) {
      if (
        fault.fired >= fault.times ||
        fault.op !== op ||
        !matches(fault.match, path, op)
      ) {
        continue;
      }
      if (++fault.matched < fault.nth) continue;
      fault.fired++;
      if (fault.short !== undefined) {
        short = fault;
        continue;
      }
      throw new DOMException(
        `Simulated ${fault.error} during ${op} of ${path}`,
        fault.error,
      );
    }
    return short;
  }

  get root() {
    return new MockDirectoryHandle(this._rootState, this._connection, this);
  }

  simulateCrash() {
    this._connection.alive = false;
    const restore = (dir) => {
      for (const child of dir.children.values()) {
        if (child instanceof DirState) {
          restore(child);
        } else {
          child.visible = child.durable.slice();
          child.lock = null;
        }
      }
    };
    restore(this._rootState);
    this._connection = { alive: true };
  }

  durableContent(name) {
    const child = this._rootState.children.get(name);
    return child instanceof FileState ? child.durable.slice() : null;
  }

  rootNames() {
    return [...this._rootState.children.keys()];
  }
}
