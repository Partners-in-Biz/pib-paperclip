import { describe, expect, it } from "vitest";
import { captureMismatch, titleOf } from "../ops/preview-server/capture.mjs";

const page = (t: string) => `<html><head><title>${t}</title></head><body>x</body></html>`;

describe("captureMismatch (PAR-9042)", () => {
  it("accepts the right host and title", () => {
    expect(captureMismatch({ status: 200, url: "https://www.agristudies.co.za/p/", html: page("A") }, { host: "agristudies.co.za" })).toBeNull();
    expect(captureMismatch({ status: 200, url: "http://127.0.0.1:3031/p/t", html: page("A  B") }, { host: "127.0.0.1", title: page("A B") })).toBeNull();
  });
  it("refuses an error page, another host and another title", () => {
    expect(captureMismatch({ status: 410, url: "http://127.0.0.1:3031/p/t", html: page("x") }, { host: "127.0.0.1" })).toMatch(/HTTP 410/);
    expect(captureMismatch({ status: 200, url: "https://other.example/", html: page("A") }, { host: "agristudies.co.za" })).toMatch(/host other\.example/);
    expect(captureMismatch({ status: 200, url: "http://127.0.0.1/", html: page("Expired") }, { host: "127.0.0.1", title: page("Hydroponics") })).toMatch(/title/);
  });
  it("reads titles", () => expect(titleOf(page(" Hi \n there "))).toBe("Hi there"));
});
