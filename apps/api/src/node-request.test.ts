import { it, expect } from "vitest";
import Fastify from "fastify";
import { createServer } from "node:http";
import { forwardedRequest } from "./node-request.ts";

it("keeps the response socket open after a forwarded JSON body is consumed", async () => {
  const app = Fastify();
  app.post("/receipt", async (request) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      body: request.body,
      complete: request.raw.complete,
      aborted: request.raw.aborted,
    };
  });
  await app.ready();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = Buffer.concat(chunks);
    const incoming = forwardedRequest(request, "/receipt", payload);
    incoming.on("error", () => {
      response.statusCode = 500;
      response.end();
    });
    app.server.emit("request", incoming, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const body = {
      hash: `0x${"ab".repeat(32)}`,
      account: `0x${"12".repeat(20)}`,
    };
    const response = await fetch(`http://127.0.0.1:${address.port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      body,
      complete: true,
      aborted: false,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await app.close();
  }
});
