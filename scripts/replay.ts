import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { EvidenceBundle, StorefrontAudit } from '../src/types';
import { compareReplay, replayEvidence } from '../src/scanner/quality/replay';

interface ReplayInput {
  evidence: EvidenceBundle;
  previous: Partial<StorefrontAudit> | null;
  source: string;
}

function extract(value: unknown, source: string): ReplayInput[] {
  if (Array.isArray(value)) return value.flatMap((item) => extract(item, source));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (record.evidence_bundle && typeof record.evidence_bundle === 'object') {
    return [{ evidence: record.evidence_bundle as EvidenceBundle, previous: record as Partial<StorefrontAudit>, source }];
  }
  if (record.scanner_version && record.network && record.product) {
    return [{ evidence: record as unknown as EvidenceBundle, previous: null, source }];
  }
  return [];
}

async function inputFiles(target: string): Promise<string[]> {
  const info = await stat(target);
  if (info.isFile()) return [target];
  if (!info.isDirectory()) return [];
  const entries = await readdir(target, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) return inputFiles(child);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.json') ? [child] : [];
  }))).flat();
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    throw new Error('Usage: npm run replay -- <evidence.json|debug-package-audit-result.json|directory>');
  }
  const files = await inputFiles(path.resolve(target));
  const inputs: ReplayInput[] = [];
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    inputs.push(...extract(parsed, file));
  }
  if (!inputs.length) throw new Error('No normalized Evidence Bundle objects were found.');
  const results = inputs.map((input) => {
    const next = replayEvidence(input.evidence);
    const comparison = compareReplay(input.previous, next);
    return {
      audit_id: input.evidence.audit_id,
      domain: input.evidence.domain,
      source: input.source,
      changed: comparison.changed,
      previous_result: input.previous,
      new_result: next,
      reason: comparison.changes
    };
  });
  process.stdout.write(JSON.stringify({
    audits_replayed: results.length,
    results_changed: results.filter((result) => result.changed).length,
    results
  }, null, 2) + '\n');
}

main().catch((error) => {
  console.error(`Replay failed: ${String(error?.message || error)}`);
  process.exitCode = 1;
});
