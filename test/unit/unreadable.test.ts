import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { BoxClient } from "box-node-sdk/sdk-gen";
import { RealBoxGateway, UnreadableFileError } from "../../src/box.js";

// A stand-in for the SDK client: a file whose extracted_text conversion failed, as Box reports it.
function failedConversion(name: string, bytes: string): BoxClient {
  return {
    files: { getFileById: async () => ({ name, representations: { entries: [
      { representation: "extracted_text", status: { state: "error" }, content: { urlTemplate: "https://x/{+asset_path}" } }] } }) },
    downloads: { downloadFile: async () => Readable.from(Buffer.from(bytes, "latin1")) },
  } as unknown as BoxClient;
}

test("a password-protected PDF gets a skippable, plain-language error", async () => {
  const gateway = new RealBoxGateway(failedConversion("Plan.pdf", "%PDF-1.7\ntrailer << /Encrypt 5 0 R >>"), "audit");
  await assert.rejects(gateway.fileText("1"), (err) =>
    err instanceof UnreadableFileError && /password-protected/.test(err.message));
});

test("any other failed conversion is also skippable, without blaming a password", async () => {
  const gateway = new RealBoxGateway(failedConversion("Broken.pdf", "%PDF-1.7\nnot much here"), "audit");
  await assert.rejects(gateway.fileText("1"), (err) =>
    err instanceof UnreadableFileError && !/password/.test(err.message));
});
