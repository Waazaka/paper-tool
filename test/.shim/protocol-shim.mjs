
export class RemoteError extends Error {
  constructor(code, message, detail) {
    super(message ?? code);
    this.code = code;
    this.detail = detail;
  }
}
export class TypertRemoteService {
  constructor(ctx, key) { this.ctx = ctx; this.serviceKey = key; }
}
export function Remote() { return () => {}; }
