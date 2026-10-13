import { Readable } from 'stream';
import {
  RequestReportPhotoUploadBody,
  RequestReportPhotoUploadResponse,
} from '@workspace/api-zod';
import { Router, type IRouter, type Request, type Response } from 'express';
import { getAuth } from '@clerk/express';

import {
  ObjectNotFoundError,
  ObjectStorageService,
} from '../lib/objectStorage';

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

router.post('/imports/request-upload-url', async (req: Request, res: Response) => {
  const userId = getAuth(req).userId;
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
    const uploadUrl = await objectStorageService.getObjectEntityUploadURL();
    const grant = await fetch('http://127.0.0.1:8091/internal/import-grant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, fileName, size, objectPath: objectStorageService.normalizeObjectEntityPath(uploadUrl) }),
    });
    if (!grant.ok) throw new Error('Unable to register private import');
    const registered = await grant.json() as { importId: string };
    res.json({ importId: registered.importId, uploadUrl });
  } catch (error) {
    req.log.error({ err: error }, 'PDF import upload unavailable');
    res.status(503).json({ detail: 'L’import privé est momentanément indisponible.' });
  }
});

function authenticatedUserId(req: Request): string | null {
  return getAuth(req).userId ?? null;
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
    const userId = authenticatedUserId(req);
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

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath =
        objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json(
        RequestReportPhotoUploadResponse.parse({
          uploadUrl: uploadURL,
          objectPath,
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, 'Error generating upload URL');
      res.status(500).json({ error: 'Failed to generate upload URL' });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get(
  '/storage/public-objects/*filePath',
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join('/') : raw;
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const response = await objectStorageService.downloadObject(file);

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));

      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
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
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
router.get('/storage/objects/*path', async (req: Request, res: Response) => {
  try {
    const userId = authenticatedUserId(req);
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
    const objectFile =
      await objectStorageService.getObjectEntityFile(objectPath);

    const response = await objectStorageService.downloadObject(objectFile);

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
      const nodeStream = Readable.fromWeb(
        response.body as ReadableStream<Uint8Array>,
      );
      nodeStream.pipe(res);
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
