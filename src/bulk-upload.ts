import express from 'express';
import multer from 'multer';
import { queueJobForAudit, type AuditQueueJob } from './audit-lifecycle';
import { BulkCsvValidationError, prepareBulkCsv } from './bulk-csv';
import type { AuditDatabase } from './db';
import type { StorefrontAudit } from './types';

export function createBulkUploadRouter(options: {
  db: Pick<AuditDatabase, 'createAudit'>;
  queue: { add(job: AuditQueueJob): unknown };
  maxBatchDomains: number;
  maxCsvBytes: number;
}) {
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: options.maxCsvBytes, files: 1 } });
  router.post('/', upload.single('file'), (req, res, next) => {
    void (async () => {
      if (!req.file) return res.status(400).json({ error: 'A CSV file is required.' });
      const prepared = prepareBulkCsv(req.file.buffer.toString('utf8'), req.body || {}, options.maxBatchDomains);
      const audits: StorefrontAudit[] = [];
      for (const config of prepared.configs) {
        const audit = await options.db.createAudit(config.domain, config.region, config.group_label, config.mode, config.modules, {
          enable_captcha_solving: false, is_bulk: true, proxy_provider: 'decodo', tested_country: config.exact_country
        });
        audits.push(audit);
        options.queue.add(queueJobForAudit(audit));
      }
      return res.status(202).json({ count: audits.length, duplicates_removed: prepared.duplicates_removed, audits });
    })().catch(next);
  });
  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof BulkCsvValidationError) return res.status(error.status).json(error.response);
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `CSV exceeds the ${options.maxCsvBytes}-byte limit.` });
    }
    next(error);
  });
  return router;
}
