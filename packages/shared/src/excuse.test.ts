/**
 * Unit tests for excuse generator: template selection, prompt construction,
 * AI response parsing, and BR-17 enforcement (never auto-send).
 */

import { describe, it, expect } from "vitest";
import {
  EXCUSE_TEMPLATES,
  buildExcusePrompt,
  parseExcuseResponse,
  type ExcuseTone,
  type TruthLevel,
  type ExcuseContext,
  type ExcuseOutput,
} from "./excuse";

// ---------------------------------------------------------------------------
// Template coverage: all 9 tone x truth_level combinations exist
// ---------------------------------------------------------------------------

describe("EXCUSE_TEMPLATES", () => {
  const tones: ExcuseTone[] = ["formal", "casual", "apologetic"];
  const truthLevels: TruthLevel[] = ["full", "vague", "white_lie"];

  it("has a template for every tone x truth_level combination (9 total)", () => {
    for (const tone of tones) {
      for (const truth of truthLevels) {
        const key = `${tone}:${truth}`;
        expect(EXCUSE_TEMPLATES[key]).toBeDefined();
        expect(typeof EXCUSE_TEMPLATES[key]).toBe("string");
        expect(EXCUSE_TEMPLATES[key].length).toBeGreaterThan(0);
      }
    }
    // Exactly 9 combinations
    expect(Object.keys(EXCUSE_TEMPLATES).length).toBe(9);
  });

  it("formal templates contain formal language markers", () => {
    expect(EXCUSE_TEMPLATES["formal:full"].toLowerCase()).toMatch(
      /regret|unfortunately|unable|sincerely/,
    );
  });

  it("casual templates contain casual language markers", () => {
    expect(EXCUSE_TEMPLATES["casual:full"].toLowerCase()).toMatch(
      /hey|sorry|can't|won't be able/,
    );
  });

  it("apologetic templates contain strong apology language", () => {
    expect(EXCUSE_TEMPLATES["apologetic:full"].toLowerCase()).toMatch(
      /deeply|so sorry|truly|apologize/,
    );
  });

  it("full truth_level references a conflicting commitment", () => {
    for (const tone of tones) {
      const template = EXCUSE_TEMPLATES[`${tone}:full`].toLowerCase();
      expect(template).toMatch(/conflict|commitment|another|prior/);
    }
  });

  it("vague truth_level uses generic phrasing", () => {
    for (const tone of tones) {
      const template = EXCUSE_TEMPLATES[`${tone}:vague`].toLowerCase();
      expect(template).toMatch(/something|unexpected|came up|unavailable/);
    }
  });

  it("white_lie truth_level references a plausible excuse", () => {
    for (const tone of tones) {
      const template = EXCUSE_TEMPLATES[`${tone}:white_lie`].toLowerCase();
      // White lies should have a placeholder that AI fills in
      expect(template).toMatch(/\{plausible_reason\}/);
    }
  });
});

// ---------------------------------------------------------------------------
// buildExcusePrompt
// ---------------------------------------------------------------------------

describe("buildExcusePrompt", () => {
  const baseContext: ExcuseContext = {
    event_title: "Q4 Board Meeting",
    event_start: "2026-03-15T14:00:00Z",
    participant_name: "Alice Smith",
    participant_category: "CLIENT",
    last_interaction_summary: "2 weeks ago",
    reputation_score: 0.85,
    tone: "formal",
    truth_level: "full",
  };

  it("includes the base template in the prompt", () => {
    const prompt = buildExcusePrompt(baseContext);
    // The formal:full template should appear as context for the AI
    expect(prompt).toContain(EXCUSE_TEMPLATES["formal:full"]);
  });

  it("includes event title in the prompt", () => {
    const prompt = buildExcusePrompt(baseContext);
    expect(prompt).toContain("Q4 Board Meeting");
  });

  it("includes participant name in the prompt", () => {
    const prompt = buildExcusePrompt(baseContext);
    expect(prompt).toContain("Alice Smith");
  });

  it("includes relationship category in the prompt", () => {
    const prompt = buildExcusePrompt(baseContext);
    expect(prompt).toContain("CLIENT");
  });

  it("includes last interaction context in the prompt", () => {
    const prompt = buildExcusePrompt(baseContext);
    expect(prompt).toContain("2 weeks ago");
  });

  it("includes reputation score context in the prompt", () => {
    const prompt = buildExcusePrompt(baseContext);
    expect(prompt).toContain("0.85");
  });

  it("includes tone instruction in the prompt", () => {
    const prompt = buildExcusePrompt(baseContext);
    expect(prompt.toLowerCase()).toContain("formal");
  });

  it("builds different prompts for different tones", () => {
    const formal = buildExcusePrompt({ ...baseContext, tone: "formal" });
    const casual = buildExcusePrompt({ ...baseContext, tone: "casual" });
    const apologetic = buildExcusePrompt({ ...baseContext, tone: "apologetic" });

    // All three should be distinct
    expect(formal).not.toBe(casual);
    expect(formal).not.toBe(apologetic);
    expect(casual).not.toBe(apologetic);
  });

  it("builds different prompts for different truth levels", () => {
    const full = buildExcusePrompt({ ...baseContext, truth_level: "full" });
    const vague = buildExcusePrompt({ ...baseContext, truth_level: "vague" });
    const whiteLie = buildExcusePrompt({ ...baseContext, truth_level: "white_lie" });

    expect(full).not.toBe(vague);
    expect(full).not.toBe(whiteLie);
    expect(vague).not.toBe(whiteLie);
  });

  it("handles null participant_name gracefully", () => {
    const ctx = { ...baseContext, participant_name: null };
    const prompt = buildExcusePrompt(ctx);
    // Should still produce a valid prompt
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).not.toContain("null");
  });

  it("handles null event_title gracefully", () => {
    const ctx = { ...baseContext, event_title: null };
    const prompt = buildExcusePrompt(ctx);
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).not.toContain("null");
  });

  it("handles null last_interaction_summary", () => {
    const ctx = { ...baseContext, last_interaction_summary: null };
    const prompt = buildExcusePrompt(ctx);
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).not.toContain("null");
  });

  it("includes instruction to generate only a draft message", () => {
    const prompt = buildExcusePrompt(baseContext);
    expect(prompt.toLowerCase()).toMatch(/draft|do not send|message only/);
  });

  it("includes white_lie plausible reason instruction when truth_level is white_lie", () => {
    const ctx = { ...baseContext, truth_level: "white_lie" as TruthLevel };
    const prompt = buildExcusePrompt(ctx);
    expect(prompt.toLowerCase()).toMatch(/plausible|believable|reason/);
  });
});

// ---------------------------------------------------------------------------
// parseExcuseResponse
// ---------------------------------------------------------------------------

describe("parseExcuseResponse", () => {
  it("parses a simple text response into ExcuseOutput", () => {
    const raw =
      "Dear Alice, I regret to inform you that I will be unable to attend the Q4 Board Meeting due to a prior commitment. I hope we can reschedule at your earliest convenience.";
    const output = parseExcuseResponse(raw, "formal", "full");

    expect(output.draft_message).toBe(raw);
    expect(output.is_draft).toBe(true);
    expect(output.tone).toBe("formal");
    expect(output.truth_level).toBe("full");
  });

  it("always sets is_draft to true (BR-17 enforcement)", () => {
    const output = parseExcuseResponse("Test message", "casual", "vague");
    expect(output.is_draft).toBe(true);
  });

  it("trims whitespace from AI response", () => {
    const raw = "  \n  Hey, sorry but I can't make it.  \n  ";
    const output = parseExcuseResponse(raw, "casual", "full");
    expect(output.draft_message).toBe("Hey, sorry but I can't make it.");
  });

  it("preserves tone and truth_level in output", () => {
    const output = parseExcuseResponse("Test", "apologetic", "white_lie");
    expect(output.tone).toBe("apologetic");
    expect(output.truth_level).toBe("white_lie");
  });

  it("returns fallback message for empty AI response", () => {
    const output = parseExcuseResponse("", "formal", "full");
    expect(output.draft_message.length).toBeGreaterThan(0);
    expect(output.is_draft).toBe(true);
  });

  it("returns fallback message for whitespace-only AI response", () => {
    const output = parseExcuseResponse("   \n\t  ", "casual", "vague");
    expect(output.draft_message.length).toBeGreaterThan(0);
    expect(output.is_draft).toBe(true);
  });

  it("suggested_reschedule is undefined by default", () => {
    const output = parseExcuseResponse("Test", "formal", "full");
    expect(output.suggested_reschedule).toBeUndefined();
  });
});
