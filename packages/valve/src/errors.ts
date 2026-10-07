// Public errors and actionable validation messages.
/** Machine readable valve failures. @example if (error.code === 'CLOSED') return; */
export type ValveErrorCode =
  | 'INVALID_OPTIONS'
  | 'COST_EXCEEDS_LIMIT'
  | 'QUEUE_FULL'
  | 'MAX_WAIT_EXCEEDED'
  | 'ABORTED'
  | 'CLOSED'
  | 'STORE_UNAVAILABLE';
/** An error belonging to valve, with job errors passed through unchanged.
 * @example if (isValveError(error, 'QUEUE_FULL')) shedLoad();
 */
export class ValveError extends Error {
  override readonly name = 'ValveError' as const;
  readonly code: ValveErrorCode;
  readonly valveId: string | undefined;
  /** Construct a typed valve failure.
   * @param code Failure category.
   * @param message Actionable explanation.
   * @param options Valve identifier and original error.
   * @example new ValveError('CLOSED', 'valve is closed');
   */
  constructor(
    code: ValveErrorCode,
    message: string,
    options?: { valveId?: string; cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.valveId = options?.valveId;
  }
}
/** Check whether an unknown error is a valve failure.
 * @param error Value to inspect.
 * @param code Optional category to match.
 * @returns Whether the value is a matching ValveError.
 * @example if (isValveError(error, 'ABORTED')) return;
 */
export function isValveError(
  error: unknown,
  code?: ValveErrorCode,
): error is ValveError {
  return (
    error instanceof ValveError && (code === undefined || error.code === code)
  );
}
export function invalid(
  id: string | undefined,
  option: string,
  value: unknown,
  hint: string,
): never {
  throw new ValveError(
    'INVALID_OPTIONS',
    `${id === undefined ? 'valve' : `valve(${JSON.stringify(id)})`}: ${option}. Got ${String(value)}. ${hint}.`,
    id === undefined ? undefined : { valveId: id },
  );
}
export function failure(
  id: string,
  code: ValveErrorCode,
  message: string,
  cause?: unknown,
): ValveError {
  return new ValveError(code, `valve(${JSON.stringify(id)}): ${message}`, {
    valveId: id,
    cause,
  });
}
