import { WASIAbi } from "../abi.js";
import { FileHandle, FSBackend, OpenMode } from "../filesystem/backend.js";
import { resizeContent } from "../filesystem/content.js";
import { FSError } from "../filesystem/error.js";
import { DirectoryNode, FileNode, FSNode } from "../filesystem/namespace.js";

/**
 * A handle on a file whose bytes live in `FileNode.content`. It holds the
 * node, so an unlinked file stays readable until the handle closes.
 */
class MemoryFileHandle implements FileHandle {
  constructor(private readonly node: FileNode) {}

  readAt(buf: Uint8Array, offset: number): number {
    const data = this.node.content;
    if (offset >= data.byteLength) return 0;
    const count = Math.min(buf.byteLength, data.byteLength - offset);
    buf.set(data.subarray(offset, offset + count));
    return count;
  }

  writeAt(data: Uint8Array, offset: number): number {
    const end = offset + data.byteLength;
    if (end > this.node.content.byteLength) this.resize(end);
    this.node.content.set(data, offset);
    return data.byteLength;
  }

  resize(size: number): void {
    try {
      this.node.content = resizeContent(this.node.content, size);
    } catch (error) {
      // A guest chooses the size, so it can ask for more than the engine
      // will allocate. For a filesystem in memory, that is a full disk.
      if (error instanceof RangeError) {
        throw new FSError(WASIAbi.WASI_ERRNO_NOSPC, error);
      }
      throw error;
    }
  }

  sync(): void {}

  datasync(): void {}

  close(): void {}
}

/**
 * The in-memory backend. File bytes live in `FileNode.content`, and the
 * namespace is the node tree itself, so there is nothing to make durable.
 */
export class MemoryFSBackend implements FSBackend {
  fileSize(node: FileNode): number {
    return node.content.byteLength;
  }

  openFile(node: FileNode, _mode: OpenMode): FileHandle {
    return new MemoryFileHandle(node);
  }

  syncDirectory(_dir: DirectoryNode): void {}

  // The syscall layer applies namespace changes to the node tree, which is
  // all the namespace there is, so there is nothing to persist.
  createChild(_parent: DirectoryNode, _name: string, _node: FSNode): void {}

  linkChild(_parent: DirectoryNode, _name: string, _node: FSNode): void {}

  removeChild(_parent: DirectoryNode, _name: string): void {}

  renameChild(
    _fromParent: DirectoryNode,
    _fromName: string,
    _toParent: DirectoryNode,
    _toName: string,
  ): void {}
}
