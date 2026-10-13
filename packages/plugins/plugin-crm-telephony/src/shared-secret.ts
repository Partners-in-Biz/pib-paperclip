import { readHeader, timingSafeStringEqual, type HeaderBag } from "./http-util.js";

export function verifySharedSecret({
  expected,
  headers,
  headerName,
}: {
  expected: string | undefined;
  headers: HeaderBag;
  headerName: string;
}): boolean {
  if (!expected) return false;

  let headerValue = readHeader(headers, headerName);
  if (!headerValue) return false;

  // Accept optional "Bearer " prefix (case-insensitive)
  if (headerValue.toLowerCase().startsWith("bearer ")) {
    headerValue = headerValue.slice(7);
  }

  return timingSafeStringEqual(expected, headerValue);
}
