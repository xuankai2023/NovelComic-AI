export class NovelcomicError extends Error {
  constructor(message: string, readonly code = 'NOVELCOMIC_ERROR') { super(message); this.name = 'NovelcomicError'; }
}
