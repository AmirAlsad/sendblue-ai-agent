export class ChatEndpointError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ChatEndpointError';
  }
}
