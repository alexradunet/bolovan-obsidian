// JSONL framing for the pi RPC protocol.
//
// pi RPC uses strict JSONL: records are delimited by LF only. Node readline is
// not protocol-compliant because it also splits on U+2028 and U+2029, which
// are valid inside JSON strings. This reader splits on "\n" only and strips a
// trailing "\r" so CRLF input survives as well.

export type JsonlLineHandler = (line: string) => void;

export function createJsonlReader(onLine: JsonlLineHandler): (chunk: string) => void {
  let buffer = "";

  return function feed(chunk: string): void {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.length > 0) {
        onLine(line);
      }
    }
  };
}
