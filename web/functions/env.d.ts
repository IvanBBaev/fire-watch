/**
 * Module types for what the Pages Functions bundler (wrangler/esbuild) inlines: a `.wasm`
 * import is a compiled `WebAssembly.Module`, a `.bin` import is the file's bytes.
 */

declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}

declare module '*.bin' {
  const bytes: ArrayBuffer;
  export default bytes;
}
