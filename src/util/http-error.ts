/**
 * Split out of `http.ts` so the failure taxonomy can classify an HttpError
 * without the two modules importing each other. A cycle between them would
 * work by accident under ESM hoisting; this makes it not a question.
 */
export class HttpError extends Error {
  status: number;
  url: string;
  body: string;

  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}
