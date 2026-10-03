export * from "./types.js";
export * from "./event-schemas.js";
export {
  createAutomationRule,
  getAutomationRule,
  listAutomationRules,
  updateAutomationRule,
  deleteAutomationRule,
} from "./automation-crud.js";
export { executeAutomationRules } from "./executor.js";
export { SCOPE_KEYS as TRIGGER_SCOPE_KEYS } from "./trigger-scope.js";
export { isOpen, recordFailure, reset } from "./circuit-breaker.js";
