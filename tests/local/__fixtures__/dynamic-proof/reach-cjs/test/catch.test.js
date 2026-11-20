"use strict";
const assert = require("node:assert");
const { double } = require("../src/calc");

describe("double", function () {
  it("doubles", function () {
    assert.strictEqual(double(2), 4);
  });
});
