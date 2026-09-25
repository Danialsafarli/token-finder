/**
 * Split out of `http.ts` so the failure taxonomy can classify an HttpError
 * without the two modules importing each other. A cycle between them would
 * work by accident under ESM hoisting; this makes it not a question.
 */
import { redactSecrets } from './redact.ts';

export class HttpError extends Error {
  status: number;
  url: string;
  body: string;

  constructor(status: number, url: string, body: string) {
    // Redacted, because this message reaches logs and any caller that
    // stringifies the error. Some provider URLs carry the credential in the
    // query string - Helius takes `?api-key=`.
    super(`HTTP ${status} for ${redactSecrets(url)}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}
