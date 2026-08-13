import { describe, it, expect } from "vitest";
import { topRepeatedNgram } from "./diagnostics";

describe("topRepeatedNgram", () => {
  it("finds a phrase repeated in a degenerate decode", () => {
    // Shape of a real observed loop: the same phrase emitted over and over,
    // with no whitespace anywhere -- which is exactly what defeated the previous
    // word-based detector.
    const looped = "これだって、サンって、たんだよ".repeat(6);
    const { count } = topRepeatedNgram(looped);
    expect(count).toBeGreaterThanOrEqual(5);
  });

  it("does not flag ordinary Japanese with incidental repetition", () => {
    // "電球" appears three times here and this is a perfectly normal sentence.
    const normal =
      "何それ?ライトチラチラするの?でも電球じゃないんだ。電球変えたらわかる。まあ電球の可能性が高いよ。";
    const { count, total } = topRepeatedNgram(normal);
    const ratio = count / total;
    // Below the count >= 5 && ratio > 0.2 threshold logResultHealth warns on.
    expect(count < 5 || ratio <= 0.2).toBe(true);
  });

  it("counts characters, not UTF-16 code units", () => {
    // Astral-plane characters are one character each; a naive string index would
    // split their surrogate pairs and produce nonsense grams.
        const text = "𩸽𩸽𩸽𩸽𩸽𩸽𩸽𩸽";
    const { gram } = topRepeatedNgram(text, 2);
    expect(Array.from(gram).length).toBe(2);
  });

  it("returns nothing for text shorter than the n-gram", () => {
    expect(topRepeatedNgram("あい", 4)).toEqual({ gram: "", count: 0, total: 0 });
  });

  it("reports a single occurrence when nothing repeats", () => {
    const { count } = topRepeatedNgram("あいうえおかきくけこ", 4);
    expect(count).toBe(1);
  });
});
