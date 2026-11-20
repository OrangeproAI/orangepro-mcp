/** Item 46: the count behind "N of M test files send HTTP requests; the map doesn't trace those calls". */
import { describe, expect, it } from "vitest";
import { sendsHttpRequests } from "../../src/local/analyze/httpTests.js";

describe("sendsHttpRequests", () => {
  it("sees an HTTP client imported or required in a JavaScript or TypeScript test", () => {
    expect(sendsHttpRequests("test/app.test.js", "const request = require('supertest');\nrequest(app).get('/');")).toBe(true);
    expect(sendsHttpRequests("test/app.test.ts", 'import axios from "axios";')).toBe(true);
    expect(sendsHttpRequests("test/app.test.mjs", 'import http from "node:http";')).toBe(true);
    expect(sendsHttpRequests("test/app.test.ts", "const res = await fetch(url);")).toBe(true);
  });

  it("does not count a test that only calls functions", () => {
    expect(sendsHttpRequests("test/sum.test.js", "const { sum } = require('../src/sum');\nexpect(sum(1, 2)).toBe(3);")).toBe(false);
    // A method named fetch on something else, or a word that contains it, is not a request.
    expect(sendsHttpRequests("test/repo.test.ts", "await repo.fetch(1);\nprefetch(2);")).toBe(false);
    expect(sendsHttpRequests("test/names.test.ts", 'import { httpStatus } from "../src/http-status";')).toBe(false);
  });

  it("sees request clients in Python, Go and JVM tests", () => {
    expect(sendsHttpRequests("tests/test_api.py", "import requests\n")).toBe(true);
    expect(sendsHttpRequests("tests/test_api.py", "from fastapi.testclient import TestClient\nclient = TestClient(app)\n")).toBe(true);
    expect(sendsHttpRequests("tests/test_math.py", "from app import add\n")).toBe(false);
    expect(sendsHttpRequests("api_test.go", 'import (\n\t"net/http/httptest"\n\t"testing"\n)')).toBe(true);
    expect(sendsHttpRequests("math_test.go", 'import "testing"')).toBe(false);
    expect(sendsHttpRequests("ApiTest.java", "private MockMvc mvc;")).toBe(true);
  });

  it("says nothing for an empty file or a language it does not read", () => {
    expect(sendsHttpRequests("test/a.test.js", "")).toBe(false);
    expect(sendsHttpRequests("spec/a_spec.rb", "require 'net/http'")).toBe(false);
  });
});
