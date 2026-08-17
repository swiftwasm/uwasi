/**
 * A parsed `subscription` record passed to `poll_oneoff`.
 */
export type WASISubscription =
  | {
      userdata: bigint;
      type: "clock";
      clockId: number;
      /** Timeout in nanoseconds, relative or absolute depending on `flags`. */
      timeout: bigint;
      precision: bigint;
      flags: number;
    }
  | {
      userdata: bigint;
      type: "fd_read" | "fd_write";
      fd: number;
    }
  | { userdata: bigint; type: "unknown"; tag: number };

/**
 * An `event` record produced by `poll_oneoff`.
 */
export interface WASIEvent {
  userdata: bigint;
  error: number;
  type: number;
  nbytes?: bigint;
  /** Peer closed / end of file on this fd (`eventrwflags::fd_readwrite_hangup`). */
  hangup?: boolean;
}

export class WASIAbi {
  /**
   * No error occurred. System call completed successfully.
   */
  static readonly WASI_ESUCCESS = 0;

  /**
   * Bad file descriptor.
   */
  static readonly WASI_ERRNO_BADF = 8;

  /**
   * Function not supported.
   */
  static readonly WASI_ENOSYS = 52;

  /**
   * Not supported, or operation not supported on socket.
   */
  static readonly WASI_ERRNO_NOTSUP = 58;

  /**
   * The clock measuring real time. Time value zero corresponds with 1970-01-01T00:00:00Z.
   */
  static readonly WASI_CLOCK_REALTIME = 0;
  /**
   * The store-wide monotonic clock, which is defined as a clock measuring real time,
   * whose value cannot be adjusted and which cannot have negative clock jumps.
   * The epoch of this clock is undefined. The absolute time value of this clock therefore has no meaning.
   */
  static readonly WASI_CLOCK_MONOTONIC = 1;
  /**
   * The CPU-time clock associated with the current process.
   */
  static readonly WASI_CLOCK_PROCESS_CPUTIME_ID = 2;
  /**
   * The CPU-time clock associated with the current thread.
   */
  static readonly WASI_CLOCK_THREAD_CPUTIME_ID = 3;

  /**
   * The time value of a clock has reached the timeout value specified in the subscription.
   */
  static readonly WASI_EVENTTYPE_CLOCK = 0;
  /**
   * File descriptor has data available for reading.
   */
  static readonly WASI_EVENTTYPE_FD_READ = 1;
  /**
   * File descriptor has capacity available for writing.
   */
  static readonly WASI_EVENTTYPE_FD_WRITE = 2;
  /**
   * Subscription clock flag: the specified timeout is an absolute deadline
   * on the subscription's clock rather than a relative interval.
   */
  static readonly WASI_SUBCLOCKFLAGS_ABSTIME = 1;

  /**
   * Permission denied.
   */
  static readonly WASI_ERRNO_ACCES = 2;
  /**
   * The file descriptor or file refers to a directory.
   */
  static readonly WASI_ERRNO_ISDIR = 31;
  /**
   * Invalid argument.
   */
  static readonly WASI_ERRNO_INVAL = 28;
  /**
   * Too many levels of symbolic links.
   */
  static readonly WASI_ERRNO_LOOP = 32;
  /**
   * Too many links.
   */
  static readonly WASI_ERRNO_MLINK = 34;
  /**
   * Filename too long.
   */
  static readonly WASI_ERRNO_NAMETOOLONG = 37;
  /**
   * Not a directory or a symbolic link to a directory.
   */
  static readonly WASI_ERRNO_NOTDIR = 54;
  /**
   * Directory not empty.
   */
  static readonly WASI_ERRNO_NOTEMPTY = 55;
  /**
   * No such file or directory.
   */
  static readonly WASI_ERRNO_NOENT = 44;
  /**
   * File exists.
   */
  static readonly WASI_ERRNO_EXIST = 20;
  /**
   * I/O error.
   */
  static readonly WASI_ERRNO_IO = 29;
  /**
   * Operation not permitted.
   */
  static readonly WASI_ERRNO_PERM = 63;
  /**
   * Not a socket.
   */
  static readonly WASI_ERRNO_NOTSOCK = 57;
  /**
   * Invalid seek (unseekable device).
   */
  static readonly WASI_ERRNO_SPIPE = 70;
  /**
   * Extension: capability insufficient.
   */
  static readonly WASI_ERRNO_NOTCAPABLE = 76;

  /**
   * Append mode: data written to the file is always appended to the end.
   */
  static readonly WASI_FDFLAGS_APPEND = 1 << 0;
  static readonly WASI_FDFLAGS_DSYNC = 1 << 1;
  static readonly WASI_FDFLAGS_NONBLOCK = 1 << 2;
  static readonly WASI_FDFLAGS_RSYNC = 1 << 3;
  static readonly WASI_FDFLAGS_SYNC = 1 << 4;

  static readonly WASI_FSTFLAGS_ATIM = 1 << 0;
  static readonly WASI_FSTFLAGS_ATIM_NOW = 1 << 1;
  static readonly WASI_FSTFLAGS_MTIM = 1 << 2;
  static readonly WASI_FSTFLAGS_MTIM_NOW = 1 << 3;

  /**
   * `path_*` lookup flag: expand the final symlink component.
   */
  static readonly WASI_LOOKUPFLAGS_SYMLINK_FOLLOW = 1 << 0;

  static readonly WASI_WHENCE_SET = 0;
  static readonly WASI_WHENCE_CUR = 1;
  static readonly WASI_WHENCE_END = 2;

  /**
   * The file descriptor or file refers to a character device inode.
   */
  static readonly WASI_FILETYPE_CHARACTER_DEVICE = 2;
  /**
   * The file descriptor or file refers to a directory inode.
   */
  static readonly WASI_FILETYPE_DIRECTORY = 3;
  /**
   * The file descriptor or file refers to a regular file inode.
   */
  static readonly WASI_FILETYPE_REGULAR_FILE = 4;
  /**
   * The file refers to a symbolic link inode.
   */
  static readonly WASI_FILETYPE_SYMBOLIC_LINK = 7;
  /**
   * Create file if it does not exist.
   */
  static readonly WASI_OFLAGS_CREAT = 1 << 0;
  /**
   * Open directory.
   */
  static readonly WASI_OFLAGS_DIRECTORY = 1 << 1;
  /**
   * Fail if not a directory.
   */
  static readonly WASI_OFLAGS_EXCL = 1 << 2;
  /**
   * Truncate to zero length.
   */
  static readonly WASI_OFLAGS_TRUNC = 1 << 3;

  static readonly IMPORT_FUNCTIONS = [
    "args_get",
    "args_sizes_get",

    "clock_res_get",
    "clock_time_get",

    "environ_get",
    "environ_sizes_get",

    "fd_advise",
    "fd_allocate",
    "fd_close",
    "fd_datasync",
    "fd_fdstat_get",
    "fd_fdstat_set_flags",
    "fd_fdstat_set_rights",
    "fd_filestat_get",
    "fd_filestat_set_size",
    "fd_filestat_set_times",
    "fd_pread",
    "fd_prestat_dir_name",
    "fd_prestat_get",
    "fd_pwrite",
    "fd_read",
    "fd_readdir",
    "fd_renumber",
    "fd_seek",
    "fd_sync",
    "fd_tell",
    "fd_write",

    "path_create_directory",
    "path_filestat_get",
    "path_filestat_set_times",
    "path_link",
    "path_open",
    "path_readlink",
    "path_remove_directory",
    "path_rename",
    "path_symlink",
    "path_unlink_file",

    "poll_oneoff",

    "proc_exit",
    "proc_raise",

    "random_get",

    "sched_yield",

    "sock_accept",
    "sock_recv",
    "sock_send",
    "sock_shutdown",
  ];

  private encoder: TextEncoder;
  private decoder: TextDecoder;

  constructor() {
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
  }

  writeString(memory: DataView, value: string, offset: number): number {
    const bytes = this.encoder.encode(value);
    const buffer = new Uint8Array(memory.buffer, offset, bytes.length);
    buffer.set(bytes);
    return bytes.length;
  }

  readString(memory: DataView, ptr: number, len: number): string {
    const buffer = new Uint8Array(memory.buffer, ptr, len);
    return this.decoder.decode(buffer);
  }

  byteLength(value: string): number {
    return this.encoder.encode(value).length;
  }

  private static readonly iovec_t = {
    size: 8,
    bufferOffset: 0,
    lengthOffset: 4,
  };

  iovViews(memory: DataView, iovs: number, iovsLen: number): Uint8Array[] {
    const iovsBuffers: Uint8Array[] = [];
    let iovsOffset = iovs;

    for (let i = 0; i < iovsLen; i++) {
      const offset = memory.getUint32(
        iovsOffset + WASIAbi.iovec_t.bufferOffset,
        true,
      );
      const len = memory.getUint32(
        iovsOffset + WASIAbi.iovec_t.lengthOffset,
        true,
      );

      iovsBuffers.push(new Uint8Array(memory.buffer, offset, len));
      iovsOffset += WASIAbi.iovec_t.size;
    }
    return iovsBuffers;
  }

  private static readonly subscription_t = {
    size: 48,
    userdataOffset: 0,
    // union tag byte of subscription_u
    tagOffset: 8,
    // payload of the union, 8-byte aligned after the tag
    contentsOffset: 16,
    clock: {
      idOffset: 16,
      timeoutOffset: 24,
      precisionOffset: 32,
      flagsOffset: 40,
    },
    fdReadWrite: {
      fdOffset: 16,
    },
  };

  static readonly event_t = {
    size: 32,
    userdataOffset: 0,
    errorOffset: 8,
    typeOffset: 10,
    fdReadWrite: {
      nbytesOffset: 16,
      flagsOffset: 24,
    },
  };

  readSubscriptions(
    memory: DataView,
    ptr: number,
    count: number,
  ): WASISubscription[] {
    const subscriptions: WASISubscription[] = [];
    const layout = WASIAbi.subscription_t;
    for (let i = 0; i < count; i++) {
      const base = ptr + i * layout.size;
      const userdata = memory.getBigUint64(base + layout.userdataOffset, true);
      const tag = memory.getUint8(base + layout.tagOffset);
      switch (tag) {
        case WASIAbi.WASI_EVENTTYPE_CLOCK:
          subscriptions.push({
            userdata,
            type: "clock",
            clockId: memory.getUint32(base + layout.clock.idOffset, true),
            timeout: memory.getBigUint64(
              base + layout.clock.timeoutOffset,
              true,
            ),
            precision: memory.getBigUint64(
              base + layout.clock.precisionOffset,
              true,
            ),
            flags: memory.getUint16(base + layout.clock.flagsOffset, true),
          });
          break;
        case WASIAbi.WASI_EVENTTYPE_FD_READ:
        case WASIAbi.WASI_EVENTTYPE_FD_WRITE:
          subscriptions.push({
            userdata,
            type:
              tag === WASIAbi.WASI_EVENTTYPE_FD_READ ? "fd_read" : "fd_write",
            fd: memory.getUint32(base + layout.fdReadWrite.fdOffset, true),
          });
          break;
        default:
          subscriptions.push({ userdata, type: "unknown", tag });
          break;
      }
    }
    return subscriptions;
  }

  writeEvent(memory: DataView, ptr: number, event: WASIEvent): void {
    const layout = WASIAbi.event_t;
    memory.setBigUint64(ptr + layout.userdataOffset, event.userdata, true);
    memory.setUint16(ptr + layout.errorOffset, event.error, true);
    memory.setUint8(ptr + layout.typeOffset, event.type);
    memory.setBigUint64(
      ptr + layout.fdReadWrite.nbytesOffset,
      event.nbytes ?? BigInt(0),
      true,
    );
    memory.setUint16(
      ptr + layout.fdReadWrite.flagsOffset,
      event.hangup ? 1 : 0,
      true,
    );
  }

  writeFilestat(
    memory: DataView,
    ptr: number,
    filetype: number,
    stat: {
      dev?: bigint;
      ino?: bigint;
      nlink?: bigint;
      size?: bigint;
      atim?: bigint;
      mtim?: bigint;
      ctim?: bigint;
    } = {},
  ): void {
    memory.setBigUint64(ptr, stat.dev ?? BigInt(0), true);
    memory.setBigUint64(ptr + 8, stat.ino ?? BigInt(0), true);
    memory.setUint8(ptr + 16, filetype);
    memory.setBigUint64(ptr + 24, stat.nlink ?? BigInt(1), true);
    memory.setBigUint64(ptr + 32, stat.size ?? BigInt(0), true);
    memory.setBigUint64(ptr + 40, stat.atim ?? BigInt(0), true);
    memory.setBigUint64(ptr + 48, stat.mtim ?? BigInt(0), true);
    memory.setBigUint64(ptr + 56, stat.ctim ?? BigInt(0), true);
  }

  /**
   * Serialize one `dirent` followed by its name into `ptr`, truncating at
   * `bufferEnd`. Returns the number of bytes written (possibly partial, per
   * `fd_readdir` semantics).
   */
  writeDirent(
    memory: DataView,
    ptr: number,
    bufferEnd: number,
    entry: { nextCookie: bigint; ino: bigint; name: string; type: number },
  ): number {
    const nameBytes = this.encoder.encode(entry.name);
    const record = new Uint8Array(24 + nameBytes.length);
    const view = new DataView(record.buffer);
    view.setBigUint64(0, entry.nextCookie, true);
    view.setBigUint64(8, entry.ino, true);
    view.setUint32(16, nameBytes.length, true);
    view.setUint8(20, entry.type);
    record.set(nameBytes, 24);
    const writable = Math.min(record.length, bufferEnd - ptr);
    new Uint8Array(memory.buffer, ptr, writable).set(
      record.subarray(0, writable),
    );
    return writable;
  }

  writeFdstat(
    memory: DataView,
    ptr: number,
    filetype: number,
    flags: number,
  ): void {
    memory.setUint8(ptr, filetype);
    memory.setUint16(ptr + 2, flags, true);
    memory.setBigUint64(ptr + 8, /* rights_base */ BigInt(0), true);
    memory.setBigUint64(ptr + 16, /* rights_inheriting */ BigInt(0), true);
  }
}

/**
 * An exception that is thrown when the process exits.
 **/
export class WASIProcExit {
  constructor(public readonly code: number) {}

  /** @deprecated Use 'code' instead.
   *  Has been renamed to have loose compatibility
   *  with other implementations **/
  get exitCode() {
    return this.code;
  }
}
