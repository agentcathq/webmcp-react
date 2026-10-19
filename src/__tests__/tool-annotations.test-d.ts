import { describe, expectTypeOf, it } from "vitest";
import type { McpToolConfigJsonSchema, RegisteredTool, ToolAnnotations } from "../index";

describe("ToolAnnotations", () => {
  it("has every annotation the spec defines", () => {
    expectTypeOf<ToolAnnotations>().toEqualTypeOf<{
      readOnlyHint?: boolean;
      untrustedContentHint?: boolean;
      consequentialHint?: boolean;
      debugging?: boolean;
    }>();
  });

  it("accepts consequentialHint and debugging in useMcpTool config", () => {
    const config: McpToolConfigJsonSchema = {
      name: "book_flight",
      description: "Book the selected flight",
      annotations: { consequentialHint: true, debugging: false },
      handler: () => ({ content: [] }),
    };
    expectTypeOf(config.annotations).toEqualTypeOf<ToolAnnotations | undefined>();
  });

  it("types them on tools returned by getTools()", () => {
    type Annotations = NonNullable<RegisteredTool["annotations"]>;
    expectTypeOf<Annotations["consequentialHint"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Annotations["debugging"]>().toEqualTypeOf<boolean | undefined>();
  });
});
