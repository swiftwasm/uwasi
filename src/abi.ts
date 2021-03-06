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
     * The clock measuring real time. Time value zero corresponds with 1970-01-01T00:00:00Z.
     */
    static readonly WASI_CLOCK_REALTIME = 0;
    /**
     * The store-wide monotonic clock, which is defined as a clock measuring real time,
     * whose value cannot be adjusted and which cannot have negative clock jumps.
     * The epoch of this clock is undefined. The absolute time value of this clock therefore has no meaning.
     */
    static readonly WASI_CLOCK_MONOTONIC = 1;

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

        "sock_recv",
        "sock_send",
        "sock_shutdown",
    ]

    private encoder: TextEncoder;

    constructor() {
        this.encoder = new TextEncoder();
    }

    writeString(memory: DataView, value: string, offset: number): number {
        const bytes = this.encoder.encode(value);
        const buffer = new Uint8Array(memory.buffer, offset, bytes.length);
        buffer.set(bytes);
        return bytes.length;
    }
    byteLength(value: string): number {
        return this.encoder.encode(value).length;
    }


    private static readonly iovec_t = {
        size: 8,
        bufferOffset: 0,
        lengthOffset: 4,
    }

    iovViews(memory: DataView, iovs: number, iovsLen: number): Uint8Array[] {
        const iovsBuffers: Uint8Array[] = [];
        let iovsOffset = iovs;

        for (let i = 0; i < iovsLen; i++) {
            const offset = memory.getUint32(iovsOffset + WASIAbi.iovec_t.bufferOffset, true);
            const len = memory.getUint32(iovsOffset + WASIAbi.iovec_t.lengthOffset, true);

            iovsBuffers.push(new Uint8Array(memory.buffer, offset, len));
            iovsOffset += WASIAbi.iovec_t.size;
        }
        return iovsBuffers;
    }
}

export class WASIProcExit {
    constructor(public readonly exitCode: number) { }
}
