import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { brainLabel, cookBrainFromInput, modelForBrain } from "../../src/pipeline/brainChoice";

describe("cook brain", () => {
  it("keeps an empty tag on Argon", () => {
    assert.equal(cookBrainFromInput(""), "argon");
    assert.equal(cookBrainFromInput(undefined), "argon");
    assert.equal(modelForBrain("argon"), "gemini-4-argon");
  });

  it("accepts the carbon tag and the model id", () => {
    assert.equal(cookBrainFromInput("carbon"), "carbon");
    assert.equal(cookBrainFromInput("gemini-4-carbon"), "carbon");
    assert.equal(modelForBrain("carbon"), "gemini-4-carbon");
    assert.equal(brainLabel("gemini-4-carbon"), "Carbon");
  });

  it("rejects any other tag", () => {
    assert.throws(() => cookBrainFromInput("gemini_38"), /brain must be argon or carbon/);
  });
});
