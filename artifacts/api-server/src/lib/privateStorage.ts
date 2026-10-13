/**
 * Pluggable private-object storage for the gateway.
 *
 * The original Replit deployment stored every private file in a GCS bucket
 * reached through the local Object Storage sidecar (127.0.0.1:1106). That
 * sidecar does not exist off Replit, so this module introduces a small backend
 * abstraction with two implementations:
 *
 *   - `LocalBackend` (default) writes and serves files from a local directory,
 *     mapping `/objects/<relative_path>` to `<root>/<relative_path>`. This is
 *     the same layout the FastAPI service uses, so both processes share one
 *     store without any change to the application object paths.
 *   - `GcsBackend` keeps the original Google Cloud Storage behaviour for
 *     deployments that still have a real bucket.
 *
 * Selection is by `MSB_STORAGE_BACKEND` (`local` | `gcs`, default `local`).
 * The private root is `MSB_PRIVATE_STORAGE_DIR`, else `<MSB_DATA_DIR>/private`,
 * else `<cwd>/msb-data/private` — identical to the Python adapter.
 */
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ObjectNotFoundError, ObjectStorageService } from './objectStorage';

export interface UploadTarget {
  uploadUrl: string;
  objectPath: string;
}

export interface StorageBackend {
  /** Serve a private object addressed as `/objects/<relativePath>`. */
  getPrivateObject(objectPath: string): Promise<Response>;
  /** Serve a public asset by search path, or `null` when it does not exist. */
  getPublicObject(filePath: string): Promise<Response | null>;
  /** Allocate a fresh private upload target for a photo or an imported PDF. */
  createUploadTarget(): Promise<UploadTarget>;
  /** Persist the body of a previously allocated upload target. */
  putUpload(uploadId: string, body: Buffer, contentType: string): Promise<void>;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
};

function contentTypeFor(file: string, fallback = 'application/octet-stream'): string {
  return MIME_BY_EXTENSION[path.extname(file).toLowerCase()] ?? fallback;
}

export function privateStorageRoot(): string {
  if (process.env.MSB_PRIVATE_STORAGE_DIR) return process.env.MSB_PRIVATE_STORAGE_DIR;
  if (process.env.MSB_DATA_DIR) return path.join(process.env.MSB_DATA_DIR, 'private');
  return path.join(process.cwd(), 'msb-data', 'private');
}

export class LocalBackend implements StorageBackend {
  constructor(private readonly root: string = privateStorageRoot()) {}

  private resolveObjectPath(objectPath: string): string {
    if (!objectPath.startsWith('/objects/')) throw new ObjectNotFoundError();
    const relative = objectPath.slice('/objects/'.length);
    const resolvedRoot = path.resolve(this.root);
    const target = path.resolve(resolvedRoot, relative);
    // Reject any traversal outside the private root.
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
      throw new ObjectNotFoundError();
    }
    return target;
  }

  async getPrivateObject(objectPath: string): Promise<Response> {
    const file = this.resolveObjectPath(objectPath);
    let info;
    try {
      info = await stat(file);
    } catch {
      throw new ObjectNotFoundError();
    }
    if (!info.isFile()) throw new ObjectNotFoundError();
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new Response(body, {
      headers: {
        'Content-Type': contentTypeFor(file),
        'Content-Length': String(info.size),
        'Cache-Control': 'private, no-store',
      },
    });
  }

  async getPublicObject(filePath: string): Promise<Response | null> {
    // This application serves no public assets; private files go through the
    // authenticated /storage/objects route only.
    void filePath;
    return null;
  }

  async createUploadTarget(): Promise<UploadTarget> {
    const objectId = randomUUID();
    return {
      uploadUrl: `/api/storage/upload/${objectId}`,
      objectPath: `/objects/uploads/${objectId}`,
    };
  }

  async putUpload(uploadId: string, body: Buffer, contentType: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new ObjectNotFoundError();
    const directory = path.join(this.root, 'uploads');
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, uploadId);
    await writeFile(target, body);
    void contentType;
  }
}

/**
 * Adapter around the original Replit/GCS object storage service so the gateway
 * code is backend-agnostic. Presigned uploads still go straight to the bucket.
 */
export class GcsBackend implements StorageBackend {
  private readonly service = new ObjectStorageService();

  async getPrivateObject(objectPath: string): Promise<Response> {
    const file = await this.service.getObjectEntityFile(objectPath);
    return this.service.downloadObject(file);
  }

  async getPublicObject(filePath: string): Promise<Response | null> {
    const file = await this.service.searchPublicObject(filePath);
    if (!file) return null;
    return this.service.downloadObject(file);
  }

  async createUploadTarget(): Promise<UploadTarget> {
    const uploadUrl = await this.service.getObjectEntityUploadURL();
    return { uploadUrl, objectPath: this.service.normalizeObjectEntityPath(uploadUrl) };
  }

  async putUpload(): Promise<void> {
    throw new Error('Direct uploads are handled by the presigned URL in GCS mode');
  }
}

let backend: StorageBackend | undefined;

export function storageBackend(): StorageBackend {
  if (!backend) {
    backend =
      (process.env.MSB_STORAGE_BACKEND ?? 'local').toLowerCase() === 'gcs'
        ? new GcsBackend()
        : new LocalBackend();
  }
  return backend;
}
