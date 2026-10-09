// Validates orca-plugin.json with Orca's own manifest parser.
//
//   ORCA_SOURCE_DIR=/path/to/stablyai/orca npm run check:manifest
//
// ORCA_SOURCE_DIR must be a checkout of stablyai/orca (only src/shared is
// read) with a node_modules that resolves `zod`; CI symlinks this repo's.
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tsImport } from 'tsx/esm/api'

const orcaDir = process.env.ORCA_SOURCE_DIR
if (!orcaDir) {
  console.error('ORCA_SOURCE_DIR is required (a checkout of stablyai/orca)')
  process.exit(1)
}
const parserPath = resolve(orcaDir, 'src/shared/plugins/plugin-manifest.ts')
if (!existsSync(parserPath)) {
  console.error(`Orca manifest parser not found at ${parserPath}`)
  process.exit(1)
}

const { parsePluginManifest } = await tsImport(pathToFileURL(parserPath).href, import.meta.url)
const manifestPath = join(import.meta.dirname, '..', 'orca-plugin.json')
const result = parsePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
if (!result.ok) {
  console.error(`orca-plugin.json is invalid: ${result.error}`)
  process.exit(1)
}
console.log(`orca-plugin.json is valid (${result.manifest.publisher}.${result.manifest.id}@${result.manifest.version})`)
