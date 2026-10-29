// What other daemon areas may use from the providers work: the spend ledger and budget check for
// the orchestrator, and decrypted keys for adapters' child environments (never logged).
export { recordSpend, checkBudget, spentToday, spentOnTask, startOfLocalDay, type BudgetCheck } from "./ledger.ts";
export { ProvidersService } from "./service.ts";
export { buildCatalog, catalogHash, CatalogService } from "./catalog.ts";
export { defaultProtector, type Protector } from "./dpapi.ts";
