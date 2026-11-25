export type ImportErrorCode =
  | 'invalid-json'
  | 'not-hookpad'
  | 'missing-key'
  | 'unsupported'
  | 'empty';

export class ImportError extends Error {
  public code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}
