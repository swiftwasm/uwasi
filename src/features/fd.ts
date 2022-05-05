import { WASIAbi } from "../abi";
import { WASIFeatureProvider, WASIOptions } from "../options";

const iovec_t = {
    size: 8,
    bufferOffset: 0,
    lengthOffset: 4,
}

/**
 * Create a feature provider that provides fd related features only for standard output and standard error
 * It uses JavaScript's `console` APIs as backend by default.
 * 
 * ```js
 * const wasi = new WASI({
 *   features: [useStdio()],
 * });
 * ```
 *
 * To use a custom backend, you can pass stdout and stderr handlers.
 *
 * ```js
 * const wasi = new WASI({
 *   features: [
 *     useStdio({
 *       stdout: (lines) => document.write(lines),
 *       stderr: (lines) => document.write(lines),
 *     })
 *   ],
 * });
 * ```
 * 
 * This provides `fd_write`, `fd_prestat_get` and `fd_prestat_dir_name` implementations to make libc work with minimal effort.
 */
export function useStdio(
    useOptions: {
        stdout: (lines: string) => void,
        stderr: (lines: string) => void
    } = {
            stdout: console.log,
            stderr: console.error,
        }
): WASIFeatureProvider {
    return (options, abi, memoryView) => {
        const decoder = new TextDecoder('utf-8');
        return {
            fd_prestat_get: (fd: number, buf: number) => {
                return WASIAbi.WASI_ERRNO_BADF;
            },
            fd_prestat_dir_name: (fd: number, buf: number) => {
                return WASIAbi.WASI_ERRNO_BADF;
            },
            fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number) => {
                if (fd > 2) return WASIAbi.WASI_ERRNO_BADF;

                const view = memoryView();
                const partialBuffers: Uint8Array[] = [];
                let iovsOffset = iovs;
                let concatBufferSize = 0;

                for (let i = 0; i < iovsLen; i++) {
                    const offset = view.getUint32(iovsOffset + iovec_t.bufferOffset, true);
                    const len = view.getUint32(iovsOffset + iovec_t.lengthOffset, true);

                    partialBuffers.push(new Uint8Array(view.buffer, offset, len));
                    iovsOffset += iovec_t.size;
                    concatBufferSize += len;
                }
                const concatBuffer = new Uint8Array(concatBufferSize);
                let offset = 0;
                for (const buffer of partialBuffers) {
                    concatBuffer.set(buffer, offset);
                    offset += buffer.length;
                }

                const lines = decoder.decode(concatBuffer);
                if (fd === 1) {
                    useOptions.stdout(lines);
                } else if (fd === 2) {
                    useOptions.stderr(lines);
                }
                view.setUint32(nwritten, concatBuffer.length, true);
                return WASIAbi.WASI_ESUCCESS;
            }
        }
    };
}

export function useFS(useOptions: { fs: any }): WASIFeatureProvider {
    return (options: WASIOptions, abi: WASIAbi, memoryView: () => DataView) => {
        // TODO: implement fd_* syscalls using `useOptions.fs`
        return {}
    }
}
