import type { z } from "zod";
import { AppError } from "@craftpanel/shared";

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    const field = first?.path.join(".");
    const details: Record<string, string> = {};
    for (const i of r.error.issues) details[i.path.join(".") || "_"] = i.message;
    throw Object.assign(new AppError(400, "validation_error", field ? `${field}: ${first.message}` : first?.message ?? "Invalid request"), { details });
  }
  return r.data;
}
