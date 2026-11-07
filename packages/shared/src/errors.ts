/** Error with an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const badRequest = (message: string, hint?: string) => new AppError(400, "bad_request", message, hint);
export const conflict = (message: string, hint?: string) => new AppError(409, "conflict", message, hint);
export const forbidden = (message = "You do not have permission to do this") => new AppError(403, "forbidden", message);
