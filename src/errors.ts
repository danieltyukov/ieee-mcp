/**
 * Stable error codes returned to MCP clients. Upstream response bodies, URLs with keys and
 * cookies never travel inside these; only the code and a message that says what to do next.
 */
export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'AUTH_REQUIRED'
  | 'NOT_CONFIGURED'
  | 'IEEE_KEY_INVALID'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'TIMEOUT'
  | 'NO_FULL_TEXT'
  | 'DOCUMENT_PARSE_FAILED'
  | 'FILE_TOO_LARGE'
  | 'BROWSER_NOT_FOUND'
  | 'BROWSER_FAILED'
  | 'LOGIN_TIMEOUT'
  | 'LOGIN_CANCELLED'
  | 'LOGIN_IN_PROGRESS'
  | 'INTERNAL_ERROR';

export class IeeeMcpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'IeeeMcpError';
  }
}

export interface SafeError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function toSafeError(error: unknown): SafeError {
  if (error instanceof IeeeMcpError) {
    return error.details
      ? { code: error.code, message: error.message, details: error.details }
      : { code: error.code, message: error.message };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'The operation failed unexpectedly. Run "ieee-xplore-mcp status" to check the configuration.',
  };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
