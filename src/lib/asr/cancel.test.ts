import { describe, it, expect } from "vitest";
import { ANALYSIS_CANCELLED, isCancelledError } from "./cancel";

describe("isCancelledError", () => {
  it("matches the sentinel the Rust side actually returns", () => {
    // `cancel::CANCELLED` in src-tauri/src/cancel.rs. If that constant ever
    // changes, this is the assertion that should fail first -- string equality
    // across the IPC boundary is the entire cancellation contract.
    expect(ANALYSIS_CANCELLED).toBe("__analysis_cancelled__");
    expect(isCancelledError(ANALYSIS_CANCELLED)).toBe(true);
  });

  it("matches when Tauri has wrapped the sentinel in a longer message", () => {
    expect(isCancelledError(new Error(`command error: ${ANALYSIS_CANCELLED}`))).toBe(true);
  });

  it("does not treat a genuine failure as a cancellation", () => {
    // The distinction that keeps a user-initiated cancel from being reported
    // back to them as "話者分離に失敗した".
    expect(isCancelledError("model is not initialized")).toBe(false);
    expect(isCancelledError(new Error("failed to encode"))).toBe(false);
    expect(isCancelledError(undefined)).toBe(false);
    expect(isCancelledError(null)).toBe(false);
  });
});
