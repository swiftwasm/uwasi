export const defaultRandomFillSync = (buffer: Uint8Array) => {
    crypto.getRandomValues(buffer)
}

