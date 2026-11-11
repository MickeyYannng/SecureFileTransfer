import { link, lstat, mkdir, open, readdir, realpath, rm, stat, statfs, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { FileListEntry, FileListResultPayload, PublicUser, StorageUsage } from "@sft/protocol";

export interface StorageLimits {
  maxFileSizeBytes: number;
  defaultQuotaBytes: number;
  defaultMaxFiles: number;
}

export class StorageFailure extends Error {
  constructor(
    readonly code: "INVALID_PATH" | "NOT_FOUND" | "FORBIDDEN" | "FILE_EXISTS",
    message: string,
  ) {
    super(message);
    this.name = "StorageFailure";
  }
}

export class StorageService {
  readonly root: string;
  private readonly usersRoot: string;
  private readonly temporaryRoot: string;

  constructor(storageRoot: string, readonly limits: StorageLimits) {
    this.root = resolve(storageRoot);
    this.usersRoot = join(this.root, "users");
    this.temporaryRoot = join(this.root, ".upload-tmp");
  }

  async initialize(): Promise<void> {
    await mkdir(this.usersRoot, { recursive: true });
    await this.assertDirectoryIsNotLink(this.root);
    await this.assertDirectoryIsNotLink(this.usersRoot);
    assertContained(this.root, this.temporaryRoot);
    await rm(this.temporaryRoot, { recursive: true, force: true });
    await mkdir(this.temporaryRoot, { recursive: true });
    await this.assertDirectoryIsNotLink(this.temporaryRoot);
  }

  async ensureUserRoot(userId: string): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new StorageFailure("FORBIDDEN", "invalid user storage identity");
    const candidate = join(this.usersRoot, userId);
    assertContained(this.usersRoot, candidate);
    await mkdir(candidate, { recursive: true });
    await this.assertDirectoryIsNotLink(candidate);
    return realpath(candidate);
  }

  async list(user: PublicUser, logicalPath: string): Promise<FileListResultPayload> {
    const userRoot = await this.ensureUserRoot(user.id);
    const components = parseLogicalPath(logicalPath, true);
    const target = await this.resolveExistingFromRoot(userRoot, components);
    const targetStat = await lstat(target);
    if (!targetStat.isDirectory()) throw new StorageFailure("INVALID_PATH", "path is not a directory");

    const directoryEntries = await readdir(target, { withFileTypes: true });
    const entries: FileListEntry[] = [];
    for (const entry of directoryEntries) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = join(target, entry.name);
      const entryStat = await stat(entryPath);
      if (!entryStat.isFile() && !entryStat.isDirectory()) continue;
      entries.push({
        name: entry.name,
        type: entryStat.isDirectory() ? "directory" : "file",
        size: entryStat.isFile() ? entryStat.size : 0,
        modifiedAt: Math.trunc(entryStat.mtimeMs),
      });
    }
    entries.sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
    const usage = await this.calculateUsage(userRoot, user);
    return { path: components.join("/"), entries, usage };
  }

  async resolveForCreate(userId: string, logicalPath: string): Promise<string> {
    const userRoot = await this.ensureUserRoot(userId);
    const components = parseLogicalPath(logicalPath, false);
    const parentComponents = components.slice(0, -1);
    const parent = await this.resolveExistingFromRoot(userRoot, parentComponents);
    const target = join(parent, components.at(-1)!);
    assertContained(userRoot, target);
    try {
      const targetStat = await lstat(target);
      if (targetStat.isSymbolicLink()) throw new StorageFailure("FORBIDDEN", "symbolic links are not allowed");
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    return target;
  }

  async prepareUploadPaths(userId: string, logicalPath: string, transferId: string): Promise<{
    finalPath: string;
    temporaryPath: string;
  }> {
    const finalPath = await this.resolveForCreate(userId, logicalPath);
    try {
      await lstat(finalPath);
      throw new StorageFailure("FILE_EXISTS", "destination already exists");
    } catch (error) {
      if (!(error instanceof StorageFailure) && !isNotFound(error)) throw error;
      if (error instanceof StorageFailure) throw error;
    }
    const userTemporaryRoot = join(this.temporaryRoot, userId);
    assertContained(this.temporaryRoot, userTemporaryRoot);
    await mkdir(userTemporaryRoot, { recursive: true });
    await this.assertDirectoryIsNotLink(userTemporaryRoot);
    const temporaryPath = join(userTemporaryRoot, `${transferId}.part`);
    assertContained(userTemporaryRoot, temporaryPath);
    return { finalPath, temporaryPath };
  }

  async getUsage(user: PublicUser): Promise<StorageUsage> {
    return this.calculateUsage(await this.ensureUserRoot(user.id), user);
  }

  async hasAvailableDiskSpace(requiredBytes: number): Promise<boolean> {
    const stats = await statfs(this.root, { bigint: true });
    const available = stats.bavail * stats.bsize;
    return available >= BigInt(requiredBytes);
  }

  async commitTemporaryFile(temporaryPath: string, finalPath: string): Promise<void> {
    assertContained(this.temporaryRoot, temporaryPath);
    assertContained(this.usersRoot, finalPath);
    await link(temporaryPath, finalPath);
    await unlink(temporaryPath);
    try {
      const directoryHandle = await open(dirname(finalPath), "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // Directory fsync is not supported consistently on Windows; the file itself is fsynced before linking.
    }
  }

  async removeTemporaryFile(temporaryPath: string): Promise<void> {
    assertContained(this.temporaryRoot, temporaryPath);
    await rm(temporaryPath, { force: true });
  }

  private async resolveExistingFromRoot(userRoot: string, components: string[]): Promise<string> {
    let current = userRoot;
    for (const component of components) {
      current = join(current, component);
      assertContained(userRoot, current);
      let currentStat;
      try {
        currentStat = await lstat(current);
      } catch (error) {
        if (isNotFound(error)) throw new StorageFailure("NOT_FOUND", "path does not exist");
        throw error;
      }
      if (currentStat.isSymbolicLink()) throw new StorageFailure("FORBIDDEN", "symbolic links are not allowed");
    }
    const canonical = await realpath(current);
    assertContained(userRoot, canonical);
    return canonical;
  }

  private async calculateUsage(userRoot: string, user: PublicUser): Promise<StorageUsage> {
    let usedBytes = 0;
    let fileCount = 0;
    const pending = [userRoot];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const entryPath = join(directory, entry.name);
        assertContained(userRoot, entryPath);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (entry.isFile()) {
          const entryStat = await stat(entryPath);
          usedBytes += entryStat.size;
          fileCount += 1;
        }
      }
    }
    return {
      usedBytes,
      fileCount,
      quotaBytes: user.quotaBytes,
      maxFiles: user.maxFiles,
      maxFileSizeBytes: this.limits.maxFileSizeBytes,
    };
  }

  private async assertDirectoryIsNotLink(path: string): Promise<void> {
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
      throw new StorageFailure("FORBIDDEN", "storage boundary is not a real directory");
    }
  }
}

function parseLogicalPath(value: string, allowRoot: boolean): string[] {
  if (typeof value !== "string" || value.length > 1024 || value.includes("\0")) {
    throw new StorageFailure("INVALID_PATH", "path is invalid");
  }
  if (value === "" && allowRoot) return [];
  if (value === "" || value.includes("\\") || value.startsWith("/") || isAbsolute(value) || win32.isAbsolute(value)) {
    throw new StorageFailure("INVALID_PATH", "only relative logical paths are allowed");
  }
  const components = value.split("/");
  for (const component of components) {
    if (!component || component === "." || component === ".." || component.length > 255) {
      throw new StorageFailure("INVALID_PATH", "path contains a forbidden component");
    }
    const baseName = component.split(".")[0]?.toUpperCase();
    if (baseName && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(baseName)) {
      throw new StorageFailure("INVALID_PATH", "path contains a reserved name");
    }
  }
  return components;
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "") return;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new StorageFailure("FORBIDDEN", "path escapes the authorized storage root");
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

