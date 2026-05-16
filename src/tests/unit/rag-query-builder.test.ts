import { describe, expect, it } from "vitest";
import { buildRagQuery } from "../../rag/queryBuilder.js";

describe("buildRagQuery", () => {
  const requirement = "做一个支持审批流、状态跟踪、接口开放和审计日志的需求设计系统";
  const approvedSummary = "01 已沉淀核心实体，03 已沉淀状态流转。";

  it("01 和 06 使用不同检索关注点", () => {
    const modeling = buildRagQuery({
      fileId: "01",
      stage: "MODELING",
      requirement,
      approvedSummary,
    });
    const detailing = buildRagQuery({
      fileId: "06",
      stage: "DETAILING",
      requirement,
      approvedSummary,
    });

    expect(modeling.query).not.toBe(detailing.query);
    expect(modeling.query).toContain("领域对象");
    expect(detailing.query).toContain("接口契约");
  });

  it("带上阶段和已批准产物摘要", () => {
    const result = buildRagQuery({
      fileId: "03",
      stage: "MODELING",
      requirement,
      approvedSummary,
    });

    expect(result.query).toContain("当前阶段：MODELING");
    expect(result.query).toContain(`已批准产物摘要：${approvedSummary}`);
  });

  it("无 approvedSummary 时不拼接摘要行", () => {
    const result = buildRagQuery({
      fileId: "07",
      stage: "DETAILING",
      requirement,
      approvedSummary: "   ",
    });

    expect(result.query).toContain("总体设计");
    expect(result.query).not.toContain("已批准产物摘要：");
  });

  it("对长 requirement 做长度控制", () => {
    const longRequirement = "超长需求".repeat(2000);
    const result = buildRagQuery({
      fileId: "01",
      stage: "MODELING",
      requirement: longRequirement,
      approvedSummary,
    });

    expect(result.query.length).toBeLessThan(longRequirement.length);
    expect(result.query).not.toContain(longRequirement);
    expect(result.query).toContain("原始需求：");
  });
});
