import { handleRequest } from './handler.mjs';

Deno.serve((request: Request) => handleRequest(request, Deno.env.toObject()));
