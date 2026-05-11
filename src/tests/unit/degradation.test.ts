import { describe, expect, it } from "vitest";
import { splitRequirementBySections } from "../../services/taskService.js";

describe("degradation", () => {
  it("splitRequirementBySections_按段切分", () => {
    const longChunk = "A".repeat(6000);
    const requirement = [
      "# 目标",
      longChunk,
      "",
      "## 范围",
      longChunk,
      "",
      "## 角色",
      longChunk,
    ].join("\n");
    const sections = splitRequirementBySections(requirement);
    expect(sections.length).toBeGreaterThan(1);
  });

  it("splitRequirementBySections_空输入返回空", () => {
    expect(splitRequirementBySections("   ")).toEqual([]);
  });

  it("splitRequirementBySections_最多6段", () => {
    const many = Array.from({ length: 20 })
      .map((_, i) => `## H${i}\n内容${i}`)
      .join("\n\n");
    expect(splitRequirementBySections(many).length).toBeLessThanOrEqual(6);
  });

  it("splitRequirementBySections_无标题时按长度降级切分", () => {
    const text = "需求".repeat(12000);
    const sections = splitRequirementBySections(text);
    expect(sections.length).toBeGreaterThanOrEqual(1);
    expect(sections.every((item) => item.trim().length > 0)).toBe(true);
  });
});
