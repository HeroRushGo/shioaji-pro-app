import type { IncomingMessage, ServerResponse } from 'node:http';
export function researchDataMiddleware(root: string, options?: {withdrawalRoot?: string}): (request: IncomingMessage, response: ServerResponse, next: () => void) => Promise<void>;
