import { gzipSync, gunzipSync } from "node:zlib";

export const largeCloudState = (id: string) =>
  id === "public-snapshot" || id.startsWith("read-model:");

/** Compress large private state transfers; existing uncompressed rows still load. */
export function encodeCloudState(id: string, value: unknown): unknown {
  if (!largeCloudState(id)) return value;
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) < 8192) return value;
  return {
    strataEncoding: "gzip-base64-v1",
    data: gzipSync(json, { level: 6 }).toString("base64"),
  };
}

export function decodeCloudState<T>(value: unknown): T {
  if (
    value &&
    typeof value === "object" &&
    "strataEncoding" in value &&
    value.strataEncoding === "gzip-base64-v1"
  ) {
    if (!("data" in value) || typeof value.data !== "string")
      throw new Error("Malformed compressed cloud state");
    const json = gunzipSync(Buffer.from(value.data, "base64"), {
      maxOutputLength: 64 * 1024 * 1024,
    });
    return JSON.parse(json.toString("utf8")) as T;
  }
  return value as T;
}
