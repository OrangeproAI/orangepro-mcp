"use strict";
const assert = require("node:assert");
const { label } = require("../src/calc");

describe("label", function () {
  it("names the number", function () {
    assert.strictEqual(label(2), "n=2");
  });
});
