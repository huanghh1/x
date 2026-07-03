import assert from "node:assert/strict";
import test from "node:test";
import { boolEnv, listEnv, numberEnv } from "./config.js";

function withEnv(name, value, callback) {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    callback();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test("numberEnv treats blank or invalid values as fallback", () => {
  withEnv("TEST_NUMBER_ENV", "", () => {
    assert.equal(numberEnv("TEST_NUMBER_ENV", 42), 42);
  });
  withEnv("TEST_NUMBER_ENV", " 15 ", () => {
    assert.equal(numberEnv("TEST_NUMBER_ENV", 42), 15);
  });
  withEnv("TEST_NUMBER_ENV", "not-a-number", () => {
    assert.equal(numberEnv("TEST_NUMBER_ENV", 42), 42);
  });
});

test("boolEnv accepts common boolean spellings and falls back on invalid values", () => {
  withEnv("TEST_BOOL_ENV", "1", () => {
    assert.equal(boolEnv("TEST_BOOL_ENV", false), true);
  });
  withEnv("TEST_BOOL_ENV", "off", () => {
    assert.equal(boolEnv("TEST_BOOL_ENV", true), false);
  });
  withEnv("TEST_BOOL_ENV", "", () => {
    assert.equal(boolEnv("TEST_BOOL_ENV", true), true);
  });
  withEnv("TEST_BOOL_ENV", "maybe", () => {
    assert.equal(boolEnv("TEST_BOOL_ENV", true), true);
  });
});

test("listEnv treats blank values as fallback", () => {
  withEnv("TEST_LIST_ENV", "", () => {
    assert.deepEqual(listEnv("TEST_LIST_ENV", ["default"]), ["default"]);
  });
  withEnv("TEST_LIST_ENV", " BTCUSDT, ETHUSDT ,, ", () => {
    assert.deepEqual(listEnv("TEST_LIST_ENV", ["default"]), ["BTCUSDT", "ETHUSDT"]);
  });
});
