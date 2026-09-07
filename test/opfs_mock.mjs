// A faithful in-Node mock of the OPFS surface `OPFSBackend` uses:
// getDirectoryHandle/getFileHandle/removeEntry/entries on directory handles,
// createSyncAccessHandle on file handles, and
// read/write/truncate/getSize/flush/close on sync access handles.
//
// The semantics that matter for the journal-lifecycle tests are modeled
// exactly:
// - A sync access handle takes an exclusive lock; a second
//   createSyncAccessHandle on the same file rejects until close (or a crash
//   releases the lock).
// - Writes and truncates through a handle are only visible to *durable*
//   storage after flush() (or close(), which flushes). `simulateCrash()`
//   releases every open handle WITHOUT flushing, dropping unflushed work -
//   exactly what a dying worker does to OPFS.
// - Storage state and handle objects are separate, mirroring real workers:
//   a handle belongs to the connection (worker) that created it. After
//   `simulateCrash()` every pre-crash handle object is dead - directory and
//   file handles reject, sync access handles throw - while `store.root`
//   hands the "fresh worker" new handles over the same durable state. This
//   is what stops a crashed backend's pending background work from running
//   on: its code may still be scheduled in-process, but every operation it
//   attempts fails, as death would have prevented them entirely.
// - removeEntry of a locked file rejects, as in Chromium.
//
// Every state mutation is appended to `store.opLog` as
// `{ path, op, ...detail }` so tests can assert cross-file ordering (e.g.
// "the journal was truncated+flushed before the meta slot recorded the
// unlink").

function domException(message, name) {
  if (typeof DOMException === "function") {
    return new DOMException(message, name);
  }
  const error = new Error(message);
  error.name = name;
  return error;
}

class FileState {
  constructor(path) {
    this.path = path;
    this.durable = new Uint8Array(0);
    this.lock = null;
  }
}

class DirState {
  constructor(path) {
    this.path = path;
    /** @type {Map<string, FileState | DirState>} */
    this.children = new Map();
  }
}

class MockSyncAccessHandle {
  #state;
  #store;
  #working;
  #cursor = 0;
  #closed = false;

  constructor(state, store) {
    this.#state = state;
    this.#store = store;
    this.#working = new Uint8Array(state.durable);
  }

  #ensureOpen() {
    if (this.#closed) {
      throw domException("The access handle is closed", "InvalidStateError");
    }
  }

  #log(op, detail = {}) {
    this.#store.opLog.push({ path: this.#state.path, op, ...detail });
  }

  read(buffer, options = {}) {
    this.#ensureOpen();
    const at = options.at !== undefined ? options.at : this.#cursor;
    if (!Number.isInteger(at) || at < 0) {
      throw new TypeError(`invalid read offset: ${at}`);
    }
    const view =
      buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer.buffer ?? buffer);
    if (at >= this.#working.byteLength) {
      this.#cursor = at;
      return 0;
    }
    const count = Math.min(view.byteLength, this.#working.byteLength - at);
    view.set(this.#working.subarray(at, at + count));
    this.#cursor = at + count;
    return count;
  }

  write(buffer, options = {}) {
    this.#ensureOpen();
    const at = options.at !== undefined ? options.at : this.#cursor;
    if (!Number.isInteger(at) || at < 0) {
      throw new TypeError(`invalid write offset: ${at}`);
    }
    let data =
      buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer.buffer ?? buffer);
    // Fault injection: a write may be short (fewer bytes accepted than
    // requested), which real OPFS reports only through the return value.
    const shortCount = this.#store._takeShortWrite(
      this.#state.path,
      data.byteLength,
    );
    if (shortCount !== null) {
      data = data.subarray(0, shortCount);
    }
    const end = at + data.byteLength;
    if (end > this.#working.byteLength) {
      // Per spec, a write past EOF extends the file, zero-filling any gap.
      const grown = new Uint8Array(end);
      grown.set(this.#working);
      this.#working = grown;
    }
    this.#working.set(data, at);
    this.#cursor = end;
    this.#log("write", { at, length: data.byteLength });
    return data.byteLength;
  }

  truncate(newSize) {
    this.#ensureOpen();
    if (!Number.isInteger(newSize) || newSize < 0) {
      throw new TypeError(`invalid truncate size: ${newSize}`);
    }
    if (this.#store._takeTruncateError(this.#state.path)) {
      throw domException(
        `Simulated quota failure truncating ${this.#state.path}`,
        "QuotaExceededError",
      );
    }
    if (newSize !== this.#working.byteLength) {
      const next = new Uint8Array(newSize);
      next.set(
        this.#working.subarray(0, Math.min(newSize, this.#working.byteLength)),
      );
      this.#working = next;
    }
    this.#cursor = Math.min(this.#cursor, newSize);
    this.#log("truncate", { size: newSize });
  }

  getSize() {
    this.#ensureOpen();
    return this.#working.byteLength;
  }

  flush() {
    this.#ensureOpen();
    this.#state.durable = new Uint8Array(this.#working);
    this.#log("flush", { size: this.#working.byteLength });
  }

  close() {
    if (this.#closed) return;
    this.flush();
    this.#closed = true;
    this.#state.lock = null;
    this.#store._openHandles.delete(this);
  }

  /** Worker died: the lock evaporates and unflushed work is lost. */
  _crash() {
    this.#closed = true;
    this.#state.lock = null;
    this.#store._openHandles.delete(this);
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
      throw domException(
        "The worker owning this handle died",
        "InvalidStateError",
      );
    }
    if (this._state.lock) {
      throw domException(
        `Access handle already open on ${this._state.path}`,
        "NoModificationAllowedError",
      );
    }
    const handle = new MockSyncAccessHandle(this._state, this._store);
    this._state.lock = handle;
    this._store._openHandles.add(handle);
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
      throw domException(
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
    const existing = this._state.children.get(name);
    if (existing) {
      if (existing instanceof DirState) {
        throw domException(`${name} is a directory`, "TypeMismatchError");
      }
      return this.#wrap(existing);
    }
    if (!options.create) {
      throw domException(`No file named ${name}`, "NotFoundError");
    }
    const state = new FileState(`${this._state.path}/${name}`);
    this._state.children.set(name, state);
    return this.#wrap(state);
  }

  async getDirectoryHandle(name, options = {}) {
    this.#ensureAlive();
    const existing = this._state.children.get(name);
    if (existing) {
      if (!(existing instanceof DirState)) {
        throw domException(`${name} is a file`, "TypeMismatchError");
      }
      return this.#wrap(existing);
    }
    if (!options.create) {
      throw domException(`No directory named ${name}`, "NotFoundError");
    }
    const state = new DirState(`${this._state.path}/${name}`);
    this._state.children.set(name, state);
    return this.#wrap(state);
  }

  async removeEntry(name, options = {}) {
    this.#ensureAlive();
    const child = this._state.children.get(name);
    if (!child) {
      throw domException(`No entry named ${name}`, "NotFoundError");
    }
    if (child instanceof FileState && child.lock) {
      throw domException(
        `${name} has an open access handle`,
        "NoModificationAllowedError",
      );
    }
    if (
      child instanceof DirState &&
      child.children.size > 0 &&
      !options.recursive
    ) {
      throw domException(`${name} is not empty`, "InvalidModificationError");
    }
    this._state.children.delete(name);
    this._store.opLog.push({ path: child.path, op: "removeEntry" });
  }

  async *entries() {
    this.#ensureAlive();
    for (const [name, state] of this._state.children) {
      yield [name, this.#wrap(state)];
    }
  }
}

export class MockOPFS {
  constructor() {
    this._openHandles = new Set();
    this._rootState = new DirState("");
    this._connection = { alive: true };
    /** @type {{path: string, op: string}[]} */
    this.opLog = [];
    this._shortWrite = null;
    this._truncateError = null;
  }

  /**
   * Make the next write to a file whose path contains `substring` short:
   * only `bytes` bytes are accepted (reported via the return value, as in
   * real OPFS). Consumed by the first matching write.
   */
  injectShortWrite(substring, bytes) {
    this._shortWrite = { substring, bytes };
  }

  _takeShortWrite(path, requested) {
    if (this._shortWrite && path.includes(this._shortWrite.substring)) {
      const count = Math.min(this._shortWrite.bytes, requested);
      this._shortWrite = null;
      return count;
    }
    return null;
  }

  /**
   * Make the next truncate on a file whose path contains `substring` throw
   * QuotaExceededError, without touching the content. Consumed by the
   * first matching truncate.
   */
  injectTruncateError(substring) {
    this._truncateError = { substring };
  }

  _takeTruncateError(path) {
    if (this._truncateError && path.includes(this._truncateError.substring)) {
      this._truncateError = null;
      return true;
    }
    return false;
  }

  /**
   * The current worker's view of the store root. After `simulateCrash()`
   * this returns handles for the fresh worker; handles obtained before the
   * crash stay dead.
   */
  get root() {
    return new MockDirectoryHandle(this._rootState, this._connection, this);
  }

  /**
   * The worker died: every open access handle is released without flushing
   * (unflushed writes are lost), and every handle object the dead worker
   * held stops working. Durable state survives for the next worker.
   */
  simulateCrash() {
    for (const handle of [...this._openHandles]) {
      handle._crash();
    }
    this._connection.alive = false;
    this._connection = { alive: true };
  }

  /** Durable bytes of a root-level file at the store level, or null. */
  durableContent(name) {
    const child = this._rootState.children.get(name);
    if (!child || child instanceof DirState) return null;
    return new Uint8Array(child.durable);
  }

  /** Names of the root's children, in insertion order. */
  rootNames() {
    return [...this._rootState.children.keys()];
  }
}
