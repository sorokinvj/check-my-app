export class ExtensionRuntimeError extends Error {
  constructor(message: string) { super(message); this.name = "ExtensionRuntimeError"; }
}
