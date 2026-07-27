import type { FastifyPluginAsync } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { limit } from '../rate-limit.js';
import type { RateLimits } from '../rate-limit.js';
import '../session.js'; // augmentation de type : request.authMember

const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.pdf']);

export interface UploadRoutesOptions {
  /** Répertoire de stockage des justificatifs, créé au besoin. */
  uploadsDir: string;
  rateLimits: RateLimits;
}

export const uploadRoutes: FastifyPluginAsync<UploadRoutesOptions> = async (app, { uploadsDir, rateLimits }) => {
  fs.mkdirSync(uploadsDir, { recursive: true });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // 10 Mo par fichier, jamais supprimés : plafond serré, sinon le disque se remplit à volonté.
  app.post('/api/uploads/receipts', { config: { rateLimit: limit(rateLimits.sensitive) } }, async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.status(400).send({ error: 'Aucun fichier reçu.' });
    }
    const extension = path.extname(file.filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return reply.status(400).send({ error: 'Format accepté : image (png, jpg, webp) ou PDF.' });
    }
    const name = `${crypto.randomUUID()}${extension}`;
    await fs.promises.writeFile(path.join(uploadsDir, name), await file.toBuffer());
    return reply.status(201).send({ path: `/uploads/${name}` });
  });

  // decorateReply: false — `reply.sendFile` est réservé au second @fastify/static, celui du front.
  await app.register(fastifyStatic, {
    root: uploadsDir,
    prefix: '/uploads/',
    decorateReply: false,
  });
};
