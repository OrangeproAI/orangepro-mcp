"use strict";
const assert = require("node:assert");
const { double } = require("../src/calc");

describe("double", function () {
  it("does not throw", function () {
    double(2);
    assert.ok(true);
  });
});
