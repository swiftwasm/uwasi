import { WASIAbi } from "../abi.js";
import { FdEntry } from "./stdio.js";
import { isResizable, ownBuffers } from "./content.js";

interface NodeMeta {
  ino: bigint;
  atim: bigint;
  mtim: bigint;
  ctim: bigint;
}

/**
 * Represents a node in the file system that is a directory.
 */
export interface DirectoryNode extends NodeMeta {
  readonly type: "dir";
  entries: Record<string, FSNode>;
}

/**
 * The number of names that link a non-directory node, as `stat` reports it.
 */
interface LinkCount {
  nlink: number;
}

/**
 * Represents a node in the file system that is a file.
 */
export interface FileNode extends NodeMeta, LinkCount {
  readonly type: "file";
  content: Uint8Array;
}

/**
 * Represents a symbolic link.
 */
export interface SymlinkNode extends NodeMeta, LinkCount {
  readonly type: "symlink";
  target: string;
}

type CharacterDeviceNode = (
  | { readonly type: "character"; kind: "stdio"; entry: FdEntry }
  | { readonly type: "character"; kind: "devnull" }
) &
  NodeMeta &
  LinkCount;

/**
 * Union type representing any node in the file system.
 */
export type FSNode =
  | DirectoryNode
  | FileNode
  | SymlinkNode
  | CharacterDeviceNode;

let nextIno = 1;
export function nowNs(): bigint {
  return BigInt(Date.now()) * BigInt(1_000_000);
}
export function stampMeta<T extends object>(node: T): T & NodeMeta {
  const meta = node as T & NodeMeta;
  if (meta.ino === undefined) {
    const now = nowNs();
    meta.ino = BigInt(nextIno++);
    meta.atim = now;
    meta.mtim = now;
    meta.ctim = now;
  }
  // A node built by hand, such as a symlink passed to `setNode`, may not
  // have a link count yet.
  const counted = node as { type?: string; nlink?: number };
  if (counted.type !== "dir" && counted.nlink === undefined) {
    counted.nlink = 1;
  }
  return meta;
}
export function makeDir(): DirectoryNode {
  return stampMeta({ type: "dir" as const, entries: Object.create(null) });
}
export function makeFile(content: Uint8Array): FileNode {
  // Web IDL rejects views over a resizable buffer wherever it expects a
  // `BufferSource`, so those contents could never be handed back out. Copy once.
  if (isResizable(content.buffer)) {
    content = new Uint8Array(content);
  }
  // `lookup` returns the live view, so a caller can build a second file on a
  // buffer the first one owns. Disown it instead of copying: whoever grows
  // first then takes a fresh buffer, and neither can write over the other's
  // bytes by reusing spare room or zeroing after a shrink.
  ownBuffers.delete(content.buffer);
  return stampMeta({ type: "file" as const, content, nlink: 1 });
}
export function makeSymlink(target: string): SymlinkNode {
  return stampMeta({ type: "symlink" as const, target, nlink: 1 });
}

const SYMLOOP_MAX = 32;

export type ResolveSuccess = {
  errno?: undefined;
  /** The resolved node, or null when the final component does not exist. */
  node: FSNode | null;
  /** Directory holding the final component, when known. */
  parent: DirectoryNode | null;
  /** Final component name, when known. */
  name: string | null;
  /** The path ended in one or more slashes. */
  trailingSlash: boolean;
};
type ResolveResult = { errno: number } | ResolveSuccess;

/**
 * Resolve `path` relative to `base` with WASI preview1 sandbox semantics:
 * `.`/`..`/`//` normalize, `..` may not escape `base`, absolute paths are
 * rejected, intermediate symlinks always expand, and the final symlink
 * expands only when `followFinal`.
 */
export function resolvePath(
  base: DirectoryNode,
  path: string,
  followFinal: boolean,
): ResolveResult {
  if (path.indexOf("\0") !== -1) return { errno: WASIAbi.WASI_ERRNO_INVAL };
  if (path.startsWith("/")) return { errno: WASIAbi.WASI_ERRNO_PERM };
  const trailingSlash = path.endsWith("/");
  const stack: DirectoryNode[] = [base];
  const components = path.split("/").filter((c) => c.length > 0);
  if (components.length === 0) {
    return { node: base, parent: null, name: null, trailingSlash };
  }
  let hops = 0;
  while (components.length > 0) {
    const component = components.shift()!;
    const isFinal = components.length === 0;
    const current = stack[stack.length - 1];
    if (component === ".") {
      if (isFinal) {
        return { node: current, parent: null, name: null, trailingSlash };
      }
      continue;
    }
    if (component === "..") {
      if (stack.length === 1) return { errno: WASIAbi.WASI_ERRNO_PERM };
      stack.pop();
      if (isFinal) {
        return {
          node: stack[stack.length - 1],
          parent: null,
          name: null,
          trailingSlash,
        };
      }
      continue;
    }
    const child: FSNode | undefined = current.entries[component];
    if (isFinal) {
      if (child && child.type === "symlink" && followFinal) {
        if (++hops > SYMLOOP_MAX) return { errno: WASIAbi.WASI_ERRNO_LOOP };
        if (child.target.startsWith("/")) {
          return { errno: WASIAbi.WASI_ERRNO_PERM };
        }
        const targetComponents = child.target
          .split("/")
          .filter((c) => c.length > 0);
        if (targetComponents.length === 0) {
          return { errno: WASIAbi.WASI_ERRNO_NOENT };
        }
        components.push(...targetComponents);
        continue;
      }
      return {
        node: child ?? null,
        parent: current,
        name: component,
        trailingSlash,
      };
    }
    if (!child) return { errno: WASIAbi.WASI_ERRNO_NOENT };
    if (child.type === "symlink") {
      if (++hops > SYMLOOP_MAX) return { errno: WASIAbi.WASI_ERRNO_LOOP };
      if (child.target.startsWith("/")) {
        return { errno: WASIAbi.WASI_ERRNO_PERM };
      }
      components.unshift(
        ...child.target.split("/").filter((c) => c.length > 0),
      );
      continue;
    }
    if (child.type !== "dir") return { errno: WASIAbi.WASI_ERRNO_NOTDIR };
    stack.push(child);
  }
  // Unreachable: the final component always returns above.
  return { errno: WASIAbi.WASI_ERRNO_NOENT };
}

/**
 * Type for file content that can be added to the file system.
 */
type FileContent = string | Uint8Array | Blob;

/**
 * In-memory implementation of a file system.
 */
export class MemoryFileSystem {
  private root: DirectoryNode;
  private preopenPaths: string[] = [];

  /**
   * Creates a new memory file system.
   * @param preopens Optional list of directories to pre-open
   */
  constructor(preopens?: { [guestPath: string]: string } | undefined) {
    this.root = makeDir();

    // Setup essential directories and special files
    this.ensureDir("/dev");
    this.setNode(
      "/dev/null",
      stampMeta({ type: "character", kind: "devnull", nlink: 1 }),
    );

    // Setup preopened directories
    if (preopens) {
      Object.keys(preopens).forEach((guestPath) => {
        // there are no 'host' paths in a memory file system, so we just use the guest path.
        this.ensureDir(guestPath);
        this.preopenPaths.push(guestPath);
      });
    } else {
      this.preopenPaths.push("/");
    }
  }

  addFile(path: string, content: string | Uint8Array): void;
  addFile(path: string, content: Blob): Promise<void>;
  addFile(path: string, content: FileContent): void | Promise<void> {
    if (typeof content === "string") {
      const data = new TextEncoder().encode(content);
      this.createFile(path, data);
      return;
    } else if (globalThis.Blob && content instanceof Blob) {
      return content.arrayBuffer().then((buffer) => {
        const data = new Uint8Array(buffer);
        this.createFile(path, data);
      });
    } else {
      this.createFile(path, content as Uint8Array);
      return;
    }
  }

  /**
   * Creates a file with the specified content.
   * @param path Path where the file should be created
   * @param content Binary content of the file
   * @returns The created file node
   */
  createFile(path: string, content: Uint8Array): FileNode {
    const fileNode = makeFile(content);
    this.setNode(path, fileNode);
    return fileNode;
  }

  /**
   * Sets a node at the specified path.
   * @param path Path where the node should be set
   * @param node The node to set
   */
  setNode(path: string, node: FSNode): void {
    stampMeta(node);
    const normalizedPath = normalizePath(path);
    const parts = normalizedPath.split("/").filter((p) => p.length > 0);

    if (parts.length === 0) {
      if (node.type !== "dir") {
        throw new Error("Root must be a directory");
      }
      this.root = node;
      return;
    }

    const fileName = parts.pop()!;
    const dirPath = "/" + parts.join("/");
    const dir = this.ensureDir(dirPath);
    dir.entries[fileName] = node;
  }

  /**
   * Gets the /dev/null special device.
   * @returns The /dev/null node
   */
  getDevNull(): FSNode {
    const node = this.lookup("/dev/null");
    if (!node) throw new Error("/dev/null not found");
    return node;
  }

  /**
   * Gets the list of pre-opened paths.
   * @returns Array of pre-opened paths
   */
  getPreopenPaths(): string[] {
    return [...this.preopenPaths];
  }

  /**
   * Looks up a node at the specified path.
   * @param path Path to look up
   * @returns The node at the path, or null if not found
   */
  lookup(path: string): FSNode | null {
    const normalizedPath = normalizePath(path);
    if (normalizedPath === "/") return this.root;

    const parts = normalizedPath.split("/").filter((p) => p.length > 0);
    let current: FSNode = this.root;

    for (const part of parts) {
      if (current.type !== "dir") return null;
      current = current.entries[part];
      if (!current) return null;
    }

    return current;
  }

  /**
   * Resolves a relative path from a directory with full WASI semantics.
   */
  resolve(dir: DirectoryNode, relativePath: string): FSNode | null {
    const result = resolvePath(dir, relativePath, true);
    if ("errno" in result && result.errno !== undefined) return null;
    return (result as ResolveSuccess).node;
  }

  /**
   * Ensures a directory exists at the specified path, creating it if necessary.
   * @param path Path to the directory
   * @returns The directory node
   */
  ensureDir(path: string): DirectoryNode {
    const normalizedPath = normalizePath(path);
    const parts = normalizedPath.split("/").filter((p) => p.length > 0);
    let current: DirectoryNode = this.root;

    for (const part of parts) {
      if (!current.entries[part]) {
        current.entries[part] = makeDir();
      }

      const next = current.entries[part];
      if (next.type !== "dir") {
        throw new Error(`"${part}" is not a directory`);
      }

      current = next;
    }

    return current;
  }

  /**
   * Creates a file in a directory.
   * @param dir Parent directory
   * @param relativePath Path relative to the directory
   * @returns The created file node
   */
  createFileIn(dir: DirectoryNode, relativePath: string): FileNode {
    const normalizedPath = normalizePath(relativePath);
    const parts = normalizedPath.split("/").filter((p) => p.length > 0);

    if (parts.length === 0) {
      throw new Error("Cannot create a file with an empty name");
    }

    const fileName = parts.pop()!;
    let current = dir;

    for (const part of parts) {
      if (!current.entries[part]) {
        current.entries[part] = makeDir();
      }

      const next = current.entries[part];
      if (next.type !== "dir") {
        throw new Error(`"${part}" is not a directory`);
      }

      current = next;
    }

    const fileNode = makeFile(new Uint8Array(0));
    current.entries[fileName] = fileNode;
    return fileNode;
  }

  removeEntry(path: string): void {
    const normalizedPath = normalizePath(path);
    const parts = normalizedPath.split("/").filter((p) => p.length > 0);
    let parentDir = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (parentDir.type !== "dir") return;
      parentDir = parentDir.entries[part] as DirectoryNode;
    }

    const fileName = parts[parts.length - 1];
    delete parentDir.entries[fileName];
  }
}

/**
 * Normalizes a path by removing duplicate slashes and trailing slashes.
 * @param path Path to normalize
 * @returns Normalized path
 */
function normalizePath(path: string): string {
  // Handle empty path
  if (!path) return "/";

  const parts = path.split("/").filter((p) => p.length > 0);
  const normalizedParts: string[] = [];

  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      normalizedParts.pop();
      continue;
    }
    normalizedParts.push(part);
  }
  if (normalizedParts.length === 0) return "/";

  const normalized = "/" + normalizedParts.join("/");
  return normalized;
}
