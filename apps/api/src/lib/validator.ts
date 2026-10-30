import { zValidator as honoZValidator, type Hook } from "@hono/zod-validator";
import type { Env, ValidationTargets, Input, MiddlewareHandler } from "hono";
import type { InferInput } from "hono/validator";
import type { ZodType, z } from "zod";

type HasUndefined<T> = undefined extends T ? true : false;

// Thin wrapper around @hono/zod-validator's zValidator that formats validation
// failures the same way apps/api/src/middleware/error-handler.ts formats a
// thrown ZodError — a string `message` plus a structured `fields` array.
// Without this hook, @hono/zod-validator's default behavior returns
// `c.json({ success: false, error: <ZodError> }, 400)` directly from the
// validator middleware — it never throws, so it never reaches the global
// onError handler, and callers that read `body.message ?? body.error` get
// the raw ZodError object. `new Error(zodErrorObject)` then stringifies to
// "[object Object]" (e.g. selecting an unsupported entity field type).
//
// The generic parameter list is copied verbatim from
// @hono/zod-validator's own declaration (minus the `HookFn` param, which this
// wrapper supplies internally and passes explicitly) so that `c.req.valid(target)` still infers
// the correct narrowed type at every call site — a simpler wrapper using
// `ReturnType<typeof honoZValidator>` collapses those generics to their
// unbound defaults and breaks inference across every route.
export const zValidator = <
  T extends ZodType,
  Target extends keyof ValidationTargets,
  E extends Env,
  P extends string,
  In = z.input<T>,
  Out = z.output<T>,
  I extends Input = {
    in: HasUndefined<In> extends true
      ? {
          [K in Target]?: [In] extends [ValidationTargets[K]]
            ? In
            : InferInput<In, K>;
        }
      : {
          [K in Target]: [In] extends [ValidationTargets[K]]
            ? In
            : InferInput<In, K>;
        };
    out: { [K in Target]: Out };
  },
  V extends I = I,
>(
  target: Target,
  schema: T,
): MiddlewareHandler<E, P, V> =>
  honoZValidator<
    T,
    Target,
    E,
    P,
    Hook<z.output<T>, E, P, Target, object, T>,
    In,
    Out,
    I,
    V
  >(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Request validation failed",
          fields: result.error.issues.map((e) => ({
            field: e.path.join("."),
            code: e.code,
            message: e.message,
          })),
        },
        400,
      );
    }
    return undefined;
  });
