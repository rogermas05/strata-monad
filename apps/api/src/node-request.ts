import { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

/** Vercel has already consumed the request body; forward a complete HTTP message. */
export function forwardedRequest(
  request: {
    socket: Socket;
    method?: string;
    headers: IncomingMessage["headers"];
  },
  url: string,
  payload?: Buffer,
) {
  const incoming = new IncomingMessage(request.socket);
  incoming.method = request.method;
  incoming.url = url;
  incoming.headers = { ...request.headers };
  // The body is buffered, rather than an unfinished chunked network stream.
  delete incoming.headers["transfer-encoding"];
  if (payload) incoming.headers["content-length"] = String(payload.length);
  else delete incoming.headers["content-length"];
  incoming.httpVersion = "1.1";
  incoming.complete = true;
  incoming.push(payload ?? null);
  if (payload) incoming.push(null);
  return incoming;
}
