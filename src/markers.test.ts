import { stripServerMarkers } from "./markers";

function assertEqual(actual: string, expected: string, msg: string) {
  if (actual.trim() !== expected.trim()) {
    throw new Error(`Test failed [${msg}]:\n  Expected: ${JSON.stringify(expected)}\n  Actual:   ${JSON.stringify(actual)}`);
  }
  console.log(`✓ Passed: ${msg}`);
}

console.log("Running markers.test.ts...");

// Test 1: Control markers
assertEqual(
  stripServerMarkers("Hello world! ⟦SWITCH:qwen3-30b-a3b-fp8⟧ ⟦NOTICE:image:served⟧ How can I help? ⟦TRUNCATED⟧⟦THINKING⟧"),
  "Hello world!   How can I help?",
  "Strips control markers"
);

// Test 2: Closed ASK marker with options
assertEqual(
  stripServerMarkers("I can help with that. ⟦ASK⟧Which framework do you prefer?||React||Vue||Svelte⟦/ASK⟧"),
  "I can help with that. \n\nWhich framework do you prefer?",
  "Strips ASK tag and extracts question"
);

// Test 3: Unclosed ASK marker
assertEqual(
  stripServerMarkers("Let me know. ⟦ASK⟧Which database engine?||Postgres||MySQL"),
  "Let me know. \n\nWhich database engine?",
  "Strips unclosed ASK tag"
);

// Test 4: ARTIFACT marker with title
assertEqual(
  stripServerMarkers("Here is your script:\n\n⟦ARTIFACT:type=code;lang=python;title=Sieve of Eratosthenes⟧\ndef sieve(n):\n    pass\n⟦/ARTIFACT⟧\nDone!"),
  "Here is your script:\n\n### Sieve of Eratosthenes\n\ndef sieve(n):\n    pass\n\nDone!",
  "Strips ARTIFACT marker and formats title"
);

console.log("All marker tests passed!");
