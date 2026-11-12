/** An error carrying an HTTP status, rendered by the error handler. */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`, "NOT_FOUND");

type WithParams = { params: Record<string, string | string[] | undefined> };
const param = (req: WithParams, name: string) => {
  const value = req.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
};
export const paramOf = param;
