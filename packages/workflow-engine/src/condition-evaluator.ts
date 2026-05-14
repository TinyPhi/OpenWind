import type { ConditionTree, FieldCondition } from "./types.js";

export function evaluateConditionTree(
  tree: ConditionTree | null,
  fields: Record<string, unknown>,
): boolean {
  if (tree === null) return true;

  if ("children" in tree && tree.op === "and") {
    return tree.children.every((c) => evaluateConditionTree(c, fields));
  }
  if ("children" in tree && tree.op === "or") {
    return tree.children.some((c) => evaluateConditionTree(c, fields));
  }
  if ("child" in tree && tree.op === "not") {
    return !evaluateConditionTree(tree.child, fields);
  }

  return evaluateFieldCondition(tree as FieldCondition, fields);
}

function evaluateFieldCondition(
  cond: FieldCondition,
  fields: Record<string, unknown>,
): boolean {
  const value = fields[cond.field];

  switch (cond.op) {
    case "eq":
      return value === cond.value;
    case "neq":
      return value !== cond.value;
    case "gt":
      return (
        typeof value === "number" &&
        typeof cond.value === "number" &&
        value > cond.value
      );
    case "gte":
      return (
        typeof value === "number" &&
        typeof cond.value === "number" &&
        value >= cond.value
      );
    case "lt":
      return (
        typeof value === "number" &&
        typeof cond.value === "number" &&
        value < cond.value
      );
    case "lte":
      return (
        typeof value === "number" &&
        typeof cond.value === "number" &&
        value <= cond.value
      );
    case "contains":
      return (
        typeof value === "string" &&
        typeof cond.value === "string" &&
        value.includes(cond.value)
      );
    case "in":
      return Array.isArray(cond.value) && cond.value.includes(value);
    case "empty":
      return value === null || value === undefined || value === "";
    case "not_empty":
      return value !== null && value !== undefined && value !== "";
    default:
      return false;
  }
}
