import { logger } from "@platform/logger";

// isolated-vm is an optional peer dep — formula evaluation degrades gracefully
// if it is not installed (returns null for all formulas).
// We use dynamic require so the package can build without it in the type graph.

interface IsolateModule {
  Isolate: new (opts: { memoryLimit: number }) => {
    createContext(): Promise<IsolateContext>;
    compileScript(src: string): Promise<Script>;
    dispose(): void;
  };
  ExternalCopy: new (data: unknown) => { copyInto(): unknown };
}

interface IsolateContext {
  global: {
    set(key: string, value: unknown): Promise<void>;
  };
  release(): void;
}

interface Script {
  run(ctx: IsolateContext, opts: { timeout: number }): Promise<unknown>;
}

const MEMORY_LIMIT_MB = 8;
const TIMEOUT_MS = 100;

function tryLoadIvm(): IsolateModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("isolated-vm") as IsolateModule;
  } catch {
    return null;
  }
}

const ivm = tryLoadIvm();

export async function evaluateFormula(
  expression: string,
  fields: Record<string, unknown>,
): Promise<unknown> {
  if (!ivm) {
    logger.warn(
      { expression },
      "Formula evaluation skipped: isolated-vm not installed",
    );
    return null;
  }

  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT_MB });

  try {
    const context = await isolate.createContext();
    const jail = context.global;

    await jail.set("fields", new ivm.ExternalCopy(fields).copyInto());

    const script = await isolate.compileScript(
      `(function() { return (${expression}); })()`,
    );

    return await script.run(context, { timeout: TIMEOUT_MS });
  } catch (err) {
    logger.warn(
      { expression, error: err instanceof Error ? err.message : String(err) },
      "Formula evaluation failed",
    );
    return null;
  } finally {
    isolate.dispose();
  }
}

interface FieldWithFormula {
  name: string;
  fieldType: string;
  config: Record<string, unknown>;
}

export async function applyFormulaFields(
  fields: FieldWithFormula[],
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = { ...values };

  for (const field of fields) {
    if (field.fieldType !== "formula") continue;

    const expression = field.config["expression"];
    if (typeof expression !== "string") continue;

    result[field.name] = await evaluateFormula(expression, result);
  }

  return result;
}
