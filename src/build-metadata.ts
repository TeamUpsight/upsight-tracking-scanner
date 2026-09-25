import { SCANNER_VERSION } from './scanner/version';

declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_TIMESTAMP__: string | undefined;
declare const __BUILD_DIRTY__: string | undefined;
declare const __SCANNER_COMPILED_BUNDLE__: boolean | undefined;

function definedBuildValue(value: string | undefined) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const compiledCommit = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : undefined;
const compiledTimestamp = typeof __BUILD_TIMESTAMP__ === 'string' ? __BUILD_TIMESTAMP__ : undefined;
const compiledDirty = typeof __BUILD_DIRTY__ === 'string' ? __BUILD_DIRTY__ : undefined;
const scanner_execution_mode = typeof __SCANNER_COMPILED_BUNDLE__ === 'boolean'
  ? (__SCANNER_COMPILED_BUNDLE__ ? 'compiled_bundle' : 'direct_source')
  : 'direct_source';
const build_commit = definedBuildValue(compiledCommit) ?? null;
const build_dirty = compiledDirty === 'false' ? false : true;
const certification_eligible = scanner_execution_mode === 'compiled_bundle' &&
  /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(build_commit || '') && !build_dirty;

export const buildMetadata = Object.freeze({
  scanner_version: SCANNER_VERSION,
  scanner_execution_mode,
  build_commit,
  build_dirty,
  build_timestamp: definedBuildValue(compiledTimestamp) ?? new Date().toISOString(),
  certification_eligible,
  execution_diagnostic: certification_eligible ? null : 'non_certifiable_execution_mode'
});
