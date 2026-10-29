// js-yaml 3 ships no types. Only the safe loader is declared, so the unsafe one cannot be used by accident.
// It is CommonJS, so it is imported as a default export (Node cannot see its named exports).
declare module "js-yaml" {
  const yaml: { safeLoad(input: string, options?: { filename?: string; json?: boolean }): unknown };
  export default yaml;
}
