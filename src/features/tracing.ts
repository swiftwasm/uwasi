import { WASIFeatureProvider } from "../options";

export function useTrace(features: WASIFeatureProvider[]): WASIFeatureProvider {
    return (options, abi, memoryView) => {
        let wasiImport: WebAssembly.ModuleImports = {};
        for (const useFeature of features) {
            const imports = useFeature(options, abi, memoryView);
            wasiImport = { ...wasiImport, ...imports };
        }
        for (const key in wasiImport) {
            const original = wasiImport[key];
            if (typeof original !== 'function') {
                continue;
            }
            wasiImport[key] = (...args: any[]) => {
                const result = original(...args);
                console.log(`[uwasi-tracing] ${key}(${args.map(a => JSON.stringify(a)).join(', ')}) => ${result}`);
                return result;
            }
        }
        return wasiImport;
    }
}
