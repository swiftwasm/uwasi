import { WASIAbi } from "../abi.js";
import { FSBackend } from "../filesystem/backend.js";
import { resizeContent } from "../filesystem/content.js";
import { FSError } from "../filesystem/error.js";
import { DirectoryNode, FileNode, FSNode } from "../filesystem/namespace.js";

/**
 * The in-memory backend. File bytes live in `FileNode.content`, and the
 * namespace is the node tree itself, so there is nothing to make durable.
 */
export class MemoryFSBackend implements FSBackend {
  fileSize(node: FileNode): number {
    return node.content.byteLength;
  }

  readAt(node: FileNode, buf: Uint8Array, offset: number): number {
    const data = node.content;
    if (offset >= data.byteLength) return 0;
    const count = Math.min(buf.byteLength, data.byteLength - offset);
    buf.set(data.subarray(offset, offset + count));
    return count;
  }

  writeAt(node: FileNode, data: Uint8Array, offset: number): void {
    const end = offset + data.byteLength;
    if (end > node.content.byteLength) this.resize(node, end);
    node.content.set(data, offset);
  }

  resize(node: FileNode, size: number): void {
    try {
      node.content = resizeContent(node.content, size);
    } catch (error) {
      // A guest chooses the size, so it can ask for more than the engine
      // will allocate. For a filesystem in memory, that is a full disk.
      if (error instanceof RangeError) {
        throw new FSError(WASIAbi.WASI_ERRNO_NOSPC, error);
      }
      throw error;
    }
  }

  sync(_node: FileNode | DirectoryNode): void {}

  datasync(_node: FileNode | DirectoryNode): void {}

  openFile(_node: FileNode): void {}

  closeFile(_node: FileNode): void {}

  createChild(parent: DirectoryNode, name: string, node: FSNode): void {
    parent.entries[name] = node;
  }

  linkChild(parent: DirectoryNode, name: string, node: FSNode): void {
    parent.entries[name] = node;
  }

  removeChild(parent: DirectoryNode, name: string): void {
    delete parent.entries[name];
  }

  renameChild(
    fromParent: DirectoryNode,
    fromName: string,
    toParent: DirectoryNode,
    toName: string,
  ): void {
    const node = fromParent.entries[fromName];
    delete fromParent.entries[fromName];
    toParent.entries[toName] = node;
  }
}
