import { WASIAbi, WASIProcExit } from "./abi";
import { WASIOptions } from "./options"

export * from "./features/all";
export * from "./features/args";
export * from "./features/clock";
export * from "./features/environ";
export * from "./features/fd";
export * from "./features/proc";
export * from "./features/random";
export * from "./features/tracing";

export class WASI {
    /**
     * `wasiImport` is an object that implements the WASI system call API. This object
     * should be passed as the `wasi_snapshot_preview1` import during the instantiation
     * of a [`WebAssembly.Instance`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WebAssembly/Instance).
     */
    readonly wasiImport: WebAssembly.ModuleImports;
    private instance: WebAssembly.Instance | null = null;
    private isStarted: boolean = false;

    constructor(options?: WASIOptions) {
        this.wasiImport = {}
        const abi = new WASIAbi();
        if (options && options.features) {
            for (const useFeature of options.features) {
                const imports = useFeature(options, abi, this.view.bind(this));
                this.wasiImport = { ...this.wasiImport, ...imports };
            }
        }
        // Provide default implementations for missing functions just returning ENOSYS.
        for (const key of WASIAbi.IMPORT_FUNCTIONS) {
            if (!(key in this.wasiImport)) {
                this.wasiImport[key] = () => { return WASIAbi.WASI_ENOSYS; };
            }
        }
    }

    private view(): DataView {
        if (!this.instance) {
            throw new Error('wasi.start() or wasi.initialize() has not been called')
        }
        if (!this.instance.exports.memory) {
            throw new Error('instance.exports.memory is undefined')
        }
        if (!(this.instance.exports.memory instanceof WebAssembly.Memory)) {
            throw new Error('instance.exports.memory is not a WebAssembly.Memory')
        }
        return new DataView(this.instance.exports.memory.buffer);
    }

    /**
     * Attempt to begin execution of `instance` as a WASI command by invoking its`_start()` export. If `instance` does not contain a `_start()` export, or if`instance` contains an `_initialize()`
     * export, then an exception is thrown.
     *
     * `start()` requires that `instance` exports a [`WebAssembly.Memory`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WebAssembly/Memory) named`memory`. If
     * `instance` does not have a `memory` export an exception is thrown.
     *
     * If `start()` is called more than once, an exception is thrown.
     */
    start(instance: WebAssembly.Instance): number {
        if (this.isStarted) {
            throw new Error('wasi.start() or wasi.initialize() has already been called')
        }
        this.isStarted = true;
        this.instance = instance;
        if (!this.instance.exports._start) {
            throw new Error('instance.exports._start is undefined')
        }
        if (typeof this.instance.exports._start !== 'function') {
            throw new Error('instance.exports._start is not a function')
        }
        try {
            this.instance.exports._start();
            return WASIAbi.WASI_ESUCCESS;
        } catch (e) {
            if (e instanceof WASIProcExit) {
                return e.exitCode;
            }
            throw e
        }
    }
    /**
     * Attempt to initialize `instance` as a WASI reactor by invoking its`_initialize()` export, if it is present. If `instance` contains a `_start()`export, then an exception is thrown.
     *
     * `initialize()` requires that `instance` exports a [`WebAssembly.Memory`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WebAssembly/Memory) named`memory`.
     * If `instance` does not have a `memory` export an exception is thrown.
     *
     * If `initialize()` is called more than once, an exception is thrown.
     */
    initialize(instance: WebAssembly.Instance): void {
        if (this.isStarted) {
            throw new Error('wasi.start() or wasi.initialize() has already been called')
        }
        this.isStarted = true;
        this.instance = instance;
        if (!this.instance.exports._initialize) {
            throw new Error('instance.exports._initialize is undefined')
        }
        if (typeof this.instance.exports._initialize !== 'function') {
            throw new Error('instance.exports._initialize is not a function')
        }
        this.instance.exports._initialize();
    }
}
