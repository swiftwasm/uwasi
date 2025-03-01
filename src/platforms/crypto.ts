import * as crypto from "crypto";

export const defaultRandomFillSync = (buffer: Uint8Array) => {
  crypto.randomFillSync(buffer);
};
