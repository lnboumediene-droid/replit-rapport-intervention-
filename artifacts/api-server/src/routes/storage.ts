import express, { Router, type IRouter, type Request, type Response } from 'express';
import {
  RequestReportPhotoUploadBody,
  RequestReportPhotoUploadResponse,
} from '@workspace/api-zod';
import { getIdentity } from '../lib/identity';
import { ObjectNotFoundError } from '../lib/objectStorage';
import { storageBackend } from '../lib/privateStorage';

const router: IRouter = Router();

router.post('/imports/request-upload-url', async (req: Request, res: Response) => {
  const userId = (await getIdentity(req))?.userId;
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const { fileName, contentType, size } = req.body ?? {};
  if (typeof fileName !== 'string' || !fileName.toLowerCase().endsWith('.pdf') || contentType !== 'application/pdf' ||
      !Number.isInteger(size) || size < 1 || size > 30 * 1024 * 1024) {
    res.status(400).json({ detail: 'Seuls les PDF de 30 Mo maximum sont acceptés.' }); return;
  }
  try {
    const permission = await fetch('http://127.0.0.1:8091/internal/import-access', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, reportId: 'import' }),
    });
    if (!permission.ok) throw new Error('Import permission service unavailable');
    const access = await permission.json() as { allowed: boolean };
    if (!access.allowed) { res.status(403).json({ detail: 'Import réservé aux responsables, à l’administratif et à la direction.' }); return; }
    const target = await storageBackend().createUploadTarget();
    const grant = await fetch('http://127.0.0.1:8091/internal/import-grant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, fileName, size, objectPath: target.objectPath }),
    });
    if (!grant.ok) throw new Error('Unable to register private import');
    const registered = await grant.json() as { importId: string };
    res.json({ importId: registered.importId, uploadUrl: absoluteUploadUrl(req, target.uploadUrl) });
  } catch (error) {
    req.log.error({ err: error }, 'PDF import upload unavailable');
    res.status(503).json({ detail: 'L’import privé est momentanément indisponible.' });
  }
});

async function authenticatedUserId(req: Request): Promise<string | null> {
  return (await getIdentity(req))?.userId ?? null;
}

/**
 * The local backend hands back a same-origin path (`/api/storage/upload/<id>`)
 * that the browser PUTs to; GCS mode hands back an already-absolute signed URL.
 * The API contract requires an absolute URL, so relative targets are resolved
 * against the incoming request (honouring the proxy's forwarded headers).
 */
function absoluteUploadUrl(req: Request, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
  const proto = forwardedProto || req.protocol || 'http';
  const host = forwardedHost || req.get('host') || `127.0.0.1:${process.env.PORT ?? 5000}`;
  return `${proto}://${host}${url.startsWith('/') ? '' : '/'}${url}`;
}

async function canReadPrivateObject(
  userId: string,
  objectPath: string,
): Promise<boolean> {
  const response = await fetch('http://127.0.0.1:8091/internal/storage-access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, objectPath }),
  });
  if (!response.ok) throw new Error(`Private file access verification failed (${response.status})`);
  const result = (await response.json()) as { allowed?: boolean };
  return result.allowed === true;
}

async function canEditReport(userId: string, reportId: string): Promise<boolean> {
  const response = await fetch('http://127.0.0.1:8091/internal/report-access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, reportId }),
  });
  if (!response.ok) return false;
  const result = (await response.json()) as { allowed?: boolean };
  return result.allowed === true;
}

/**
 * POST /reports/:reportId/photos/request-upload-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 * The URL is scoped to an authenticated user and accepts images only.
 */
router.post(
  '/reports/:reportId/photos/request-upload-url',
  async (req: Request, res: Response) => {
    const userId = await authenticatedUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rawReportId = req.params.reportId;
    const reportId = Array.isArray(rawReportId) ? rawReportId[0] : rawReportId;
    if (!(await canEditReport(userId, reportId))) {
      res.status(404).json({ error: 'Dossier introuvable' });
      return;
    }
    const parsed = RequestReportPhotoUploadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Missing or invalid required fields' });
      return;
    }

    try {
      const { size, contentType } = parsed.data;
      if (
        size < 1 ||
        size > 12 * 1024 * 1024 ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(contentType)
      ) {
        res.status(400).json({ error: 'Invalid image type or size' });
        return;
      }

      const target = await storageBackend().createUploadTarget();

      res.json(
        RequestReportPhotoUploadResponse.parse({
          uploadUrl: absoluteUploadUrl(req, target.uploadUrl),
          objectPath: target.objectPath,
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, 'Error generating upload URL');
      res.status(500).json({ error: 'Failed to generate upload URL' });
    }
  },
);

/**
 * PUT /storage/upload/:uploadId
 *
 * Local-storage upload endpoint. In GCS mode the client PUTs straight to the
 * presigned bucket URL instead; in local mode this route receives the bytes and
 * writes them under the private root at the reserved `/objects/uploads/<id>`
 * path. The upload id is an unguessable UUID allocated by createUploadTarget,
 * so possession of the URL is the capability.
 */
router.put(
  '/storage/upload/:uploadId',
  express.raw({ type: '*/*', limit: '30mb' }),
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.uploadId;
      const uploadId = Array.isArray(raw) ? raw[0] : raw;
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.length === 0) {
        res.status(400).json({ error: 'Empty upload' });
        return;
      }
      await storageBackend().putUpload(uploadId, body, req.get('content-type') ?? '');
      res.status(201).end();
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: 'Upload target not found' });
        return;
      }
      req.log.error({ err: error }, 'Error storing upload');
      res.status(500).json({ error: 'Failed to store upload' });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets. This application has no public bucket; the route is kept
 * for API compatibility and returns 404 when no backend provides the asset.
 */
router.get(
  '/storage/public-objects/*filePath',
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join('/') : raw;
      const response = await storageBackend().getPublicObject(filePath);
      if (!response) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (response.body) {
        const { Readable } = await import('node:stream');
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>).pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      req.log.error({ err: error }, 'Error serving public object');
      res.status(500).json({ error: 'Failed to serve public object' });
    }
  },
);

/**
 * GET /storage/objects/*
 *
 * Serve private objects through the configured backend (local directory by
 * default, GCS when selected). Every request is authorised against the report
 * ACL before the bytes are read.
 */
router.get('/storage/objects/*path', async (req: Request, res: Response) => {
  try {
    const userId = await authenticatedUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join('/') : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const allowed = await canReadPrivateObject(userId, objectPath);
    if (!allowed) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const response = await storageBackend().getPrivateObject(objectPath);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (objectPath.endsWith('.pdf')) res.setHeader('Content-Type', 'application/pdf');
    else if (!(res.getHeader('Content-Type')?.toString().startsWith('image/'))) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment');
    }
    if (response.body) {
      const { Readable } = await import('node:stream');
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, 'Object not found');
      res.status(404).json({ error: 'Object not found' });
      return;
    }
    req.log.error({ err: error }, 'Error serving object');
    res.status(500).json({ error: 'Failed to serve object' });
  }
});

export default router;
