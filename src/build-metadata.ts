import { SCANNER_VERSION } from './scanner/version';

declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_TIMESTAMP__: string | undefined;

function definedBuildValue(value: string | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const compiledCommit = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : undefined;
const compiledTimestamp = typeof __BUILD_TIMESTAMP__ === 'string' ? __BUILD_TIMESTAMP__ : undefined;

export const buildMetadata = Object.freeze({
  scanner_version: SCANNER_VERSION,
  build_commit: definedBuildValue(compiledCommit) ?? definedBuildValue(process.env.BUILD_COMMIT) ?? null,
  build_timestamp: definedBuildValue(compiledTimestamp) ?? definedBuildValue(process.env.BUILD_TIMESTAMP) ?? new Date().toISOString()
});
