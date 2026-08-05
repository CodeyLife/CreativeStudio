import { describe, expect, it } from "vitest";
import { FOUNDATION_TASK_CONTRACTS, foundationSchemaForTask } from "../application/foundation-contract";
import { BOOK_SYNOPSIS_SCHEMA, BOOK_TITLE_CANDIDATES_SCHEMA } from "../application/book-synopsis";
import { CHAPTER_TITLE_SCHEMA } from "../application/chapter-title";
import { foundationEvaluationSchema } from "../craft-rule";
import { runtimeLearningAssessmentSchema } from "../learning-assessment";
import { assertNativeJsonSchema, NativeSchemaCompatibilityError } from "../native-schema";
import { characterEnrichmentSchema, chapterMemorySchema, factExtractionSchema, reviewerSchema } from "../prompts/schemas";
import { authorRevisionAlignmentSchema, targetedRevisionBatchSchema } from "../prompts/chapter-revision";
import { foundationReviewSchema } from "../prompts/foundation-review";
import { storyArcBundleSchema, storyArcChaptersOutputSchema, storyArcPlanBatchSchema, storyArcReviewSchema } from "../prompts/story-arc";
import { schemaForSkills, skillIterationSchema } from "../evaluation/skill-iteration";

describe("native structured schema compatibility", () => {
  it("accepts every provider-facing structured output schema", () => {
    const schemas: Array<[string, Record<string, unknown>]> = [
      ["reviewer", reviewerSchema],
      ["fact-extraction", factExtractionSchema],
      ["chapter-memory", chapterMemorySchema],
      ["character-enrichment", characterEnrichmentSchema],
      ["story-arc-plan-batch", storyArcPlanBatchSchema],
      ["story-arc-chapters", storyArcChaptersOutputSchema],
      ["story-arc-bundle", storyArcBundleSchema],
      ["story-arc-review", storyArcReviewSchema],
      ["learning", runtimeLearningAssessmentSchema],
      ["skill-iteration", skillIterationSchema],
      ["skill-iteration-dynamic", schemaForSkills(["skill-a", "skill-b"])],
      ["book-synopsis", BOOK_SYNOPSIS_SCHEMA],
      ["book-title-candidates", BOOK_TITLE_CANDIDATES_SCHEMA],
      ["chapter-title", CHAPTER_TITLE_SCHEMA],
      ["author-revision-alignment", authorRevisionAlignmentSchema],
      ["targeted-revision-batch", targetedRevisionBatchSchema],
      ["foundation-review", foundationReviewSchema],
      ["foundation-evaluation", foundationEvaluationSchema],
    ];
    for (const [name, schema] of schemas) expect(() => assertNativeJsonSchema(schema, name)).not.toThrow();
    for (const taskKey of Object.keys(FOUNDATION_TASK_CONTRACTS)) {
      expect(() => assertNativeJsonSchema(foundationSchemaForTask(taskKey), `foundation:${taskKey}`)).not.toThrow();
    }
  });

  it("accepts nullable primitive and object fields without allowing arbitrary unions", () => {
    expect(() => assertNativeJsonSchema({
      type: "object",
      additionalProperties: false,
      required: ["rationale", "evidence"],
      properties: {
        rationale: { type: ["string", "null"] },
        evidence: {
          type: ["object", "null"],
          additionalProperties: false,
          required: ["impact"],
          properties: { impact: { enum: ["core", "local"] } },
        },
      },
    }, "nullable")).not.toThrow();
    expect(() => assertNativeJsonSchema({
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: ["object", "string"] } },
    }, "arbitrary-union")).toThrow(NativeSchemaCompatibilityError);
  });

  it("rejects optional properties, dynamic objects, empty objects and combinators", () => {
    const invalidSchemas = [
      { type: "object", additionalProperties: false, required: [], properties: {} },
      { type: "object", additionalProperties: true, required: ["value"], properties: { value: { type: "string" } } },
      { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "object", additionalProperties: false, required: [], properties: {} } } },
      { type: "object", additionalProperties: false, required: ["value"], properties: { value: {} } },
      { type: "object", additionalProperties: false, required: ["value"], properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } } },
      { type: "object", additionalProperties: false, required: [], properties: { value: { type: "string" } } },
    ];
    for (const schema of invalidSchemas) {
      expect(() => assertNativeJsonSchema(schema, "invalid")).toThrow(NativeSchemaCompatibilityError);
    }
  });

  it("keeps deprecated story-arc fields outside the model contract", () => {
    const plan = (storyArcPlanBatchSchema.properties as Record<string, unknown>).arc as { properties: Record<string, unknown> };
    const phases = plan.properties.phases as { items: { properties: Record<string, unknown> } };
    expect(plan.properties).not.toHaveProperty("authorIntent");
    expect(plan.properties).not.toHaveProperty("thematicQuestions");
    expect(phases.items.properties).not.toHaveProperty("exitCondition");
  });
});
