export class AppError extends Error {
  status: number;
  code: string;
  detail?: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const badRequest = (code: string, msg: string, detail?: unknown) =>
  new AppError(400, code, msg, detail);
export const unauthorized = (msg = "authentication required") => new AppError(401, "unauthorized", msg);
export const forbidden = (msg = "action not permitted for this role") => new AppError(403, "forbidden", msg);
export const notFound = (msg = "resource not found") => new AppError(404, "not_found", msg);
export const conflict = (code: string, msg: string, detail?: unknown) => new AppError(409, code, msg, detail);
export const unprocessable = (code: string, msg: string, detail?: unknown) =>
  new AppError(422, code, msg, detail);
