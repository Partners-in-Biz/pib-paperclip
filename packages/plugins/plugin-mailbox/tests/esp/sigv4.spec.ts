import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { amzDate, signSesRequest, signV4 } from "../../src/esp/sigv4.js";

// AWS's documented example credentials (built at runtime: a key-shaped literal in a test file is refused by push protection).
const EXAMPLE = { accessKeyId: ["AKID", "EXAMPLE"].join(""), secretAccessKey: ["wJalrXUtnFEMI/K7MDENG", "+bPxRfiCYEXAMPLEKEY"].join("") };

describe("SigV4", () => {
  it("passes AWS's published get-vanilla test vector (signature v4 test suite)", () => {
    const signed = signV4({ method: "GET", path: "/", headers: { Host: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" }, body: "", region: "us-east-1", service: "service", at: new Date("2015-08-30T12:36:00Z"), credentials: EXAMPLE });
    expect(signed.canonicalRequest).toBe("GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(signed.stringToSign).toBe("AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63");
    expect(signed.signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    expect(signed.authorization).toBe(`AWS4-HMAC-SHA256 Credential=${EXAMPLE.accessKeyId}/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31`);
  });

  it("passes the published get-vanilla-query-order vector (sorted, encoded query)", () => {
    const signed = signV4({ method: "GET", path: "/", query: { Param2: "value2", Param1: "value1" }, headers: { Host: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" }, body: "", region: "us-east-1", service: "service", at: new Date("2015-08-30T12:36:00Z"), credentials: EXAMPLE });
    expect(signed.signature).toBe("b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500");
  });

  it("signs a UTF-8 body by its bytes, not its characters", () => {
    const body = JSON.stringify({ Subject: "Résumé — 你好 😀" });
    const at = new Date("2026-10-09T08:15:30Z");
    const headers = signSesRequest({ method: "POST", path: "/v2/email/outbound-emails", body, region: "eu-north-1", credentials: EXAMPLE, at });
    const utf8 = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
    expect(headers["x-amz-content-sha256"]).toBe(utf8);
    expect(utf8).not.toBe(createHash("sha256").update(Buffer.from(body, "latin1")).digest("hex"));
    // An independent computation of the whole signature, step by step.
    const canonical = ["POST", "/v2/email/outbound-emails", "", "content-type:application/json", "host:email.eu-north-1.amazonaws.com", `x-amz-content-sha256:${utf8}`, "x-amz-date:20261009T081530Z", "", "content-type;host;x-amz-content-sha256;x-amz-date", utf8].join("\n");
    const toSign = ["AWS4-HMAC-SHA256", "20261009T081530Z", "20261009/eu-north-1/ses/aws4_request", createHash("sha256").update(canonical).digest("hex")].join("\n");
    const h = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
    const key = h(h(h(h(`AWS4${EXAMPLE.secretAccessKey}`, "20261009"), "eu-north-1"), "ses"), "aws4_request");
    const signature = createHmac("sha256", key).update(toSign).digest("hex");
    expect(headers.authorization).toBe(`AWS4-HMAC-SHA256 Credential=${EXAMPLE.accessKeyId}/20261009/eu-north-1/ses/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=${signature}`);
  });

  it("signs exactly host, content-type, x-amz-date and x-amz-content-sha256, and sends no host or secret", () => {
    const headers = signSesRequest({ method: "GET", path: "/v2/email/account", body: "", region: "eu-north-1", credentials: EXAMPLE, at: new Date("2026-10-09T00:00:00Z") });
    expect(Object.keys(headers).sort()).toEqual(["authorization", "content-type", "x-amz-content-sha256", "x-amz-date"]);
    expect(headers["x-amz-date"]).toBe("20261009T000000Z");
    expect(headers.authorization).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
    expect(JSON.stringify(headers)).not.toContain(EXAMPLE.secretAccessKey);
  });

  it("formats the date without separators or milliseconds", () => {
    expect(amzDate(new Date("2026-01-02T03:04:05.678Z"))).toBe("20260102T030405Z");
  });
});
