/**
 * Erreur portant un statut HTTP et un code lisible par le client.
 * Les messages restent en français : ils sont affichés tels quels dans la PWA.
 */
export class HttpError extends Error {
  constructor(status, message, code = 'request_error') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function statusOf(error) {
  if (error instanceof HttpError) return error.status;
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}
