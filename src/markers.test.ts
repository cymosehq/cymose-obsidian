import { describe, it, expect } from "vitest";
import { stripServerMarkers } from "./markers";

describe("stripServerMarkers", () => {
  it("strips control markers", () => {
    expect(
      stripServerMarkers("Hello world! ⟦SWITCH:qwen3-30b-a3b-fp8⟧ ⟦NOTICE:image:served⟧ How can I help? ⟦TRUNCATED⟧⟦THINKING⟧").trim()
    ).toBe("Hello world!   How can I help?");
  });

  it("strips closed ASK tag and extracts question", () => {
    expect(
      stripServerMarkers("I can help with that. ⟦ASK⟧Which framework do you prefer?||React||Vue||Svelte⟦/ASK⟧").trim()
    ).toBe("I can help with that. \n\nWhich framework do you prefer?");
  });

  it("strips unclosed ASK tag", () => {
    expect(
      stripServerMarkers("Let me know. ⟦ASK⟧Which database engine?||Postgres||MySQL").trim()
    ).toBe("Let me know. \n\nWhich database engine?");
  });

  it("strips ARTIFACT marker and formats title", () => {
    expect(
      stripServerMarkers("Here is your script:\n\n⟦ARTIFACT:type=code;lang=python;title=Sieve of Eratosthenes⟧\ndef sieve(n):\n    pass\n⟦/ARTIFACT⟧\nDone!").trim()
    ).toBe("Here is your script:\n\n### Sieve of Eratosthenes\n\ndef sieve(n):\n    pass\n\nDone!");
  });
});
