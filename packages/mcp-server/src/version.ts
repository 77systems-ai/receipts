import { createRequire } from 'node:module';

/** The installed package version, read once from package.json so no runtime string drifts from a release. */
export const PACKAGE_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
