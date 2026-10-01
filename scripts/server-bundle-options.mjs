// Bundled CommonJS dependencies such as YAML use Node builtins via require().
// Preserve that capability in the otherwise standalone ESM server bundle.
export const SERVER_ESM_BANNER = "import { createRequire as __hd_createRequire } from 'node:module'; const require = __hd_createRequire(import.meta.url);"
