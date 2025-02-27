import { WASIAbi } from "./abi";


export type WASIFeatureProvider = (options: WASIOptions, abi: WASIAbi, view: () => DataView) => WebAssembly.ModuleImports;

export interface WASIOptions {
    /**
     * An array of strings that the WebAssembly application will
     * see as command line arguments. The first argument is the virtual path to the
     * WASI command itself.
     */
    args?: string[] | undefined;
    /**
     * An object similar to `process.env` that the WebAssembly
     * application will see as its environment.
     */
    env?: { [key: string]: string } | undefined;
    /**
     * An object that represents the WebAssembly application's
     * sandbox directory structure. The string keys of `preopens` are treated as
     * directories within the sandbox. The corresponding values in `preopens` are
     * the real paths to those directories on the host filesystem.
     */
    preopens?: { [guestPath: string]: string } | undefined;

    /**
     * A list of functions that returns import object for the WebAssembly application.
     */
    features?: WASIFeatureProvider[];
}
