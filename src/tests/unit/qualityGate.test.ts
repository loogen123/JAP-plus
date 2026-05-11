import { describe, expect, it } from "vitest";
import { runQualityGate } from "../../quality/index.js";

describe("qualityGate", () => {
  it("scopeCheck_01包含数据库表_阻断", async () => {
    const report = await runQualityGate("01", "这里定义数据库表 users", { "01": "这里定义数据库表 users" });
    expect(report.passed).toBe(false);
    expect(report.totalErrors).toBeGreaterThan(0);
  });

  it("scopeCheck_01纯范围_通过", async () => {
    const report = await runQualityGate("01", "目标\n范围\n用户角色\n核心场景", { "01": "目标\n范围\n用户角色\n核心场景" });
    expect(report.passed).toBe(true);
  });

  it("namingConsistency_命名变体_告警不阻断", async () => {
    const report = await runQualityGate("04", "字段 userEmail", {
      "02": "user_email",
      "04": "userEmail user_email",
    });
    expect(report.totalWarnings).toBeGreaterThan(0);
  });

  it("crossFileConflict_状态缺少能力_阻断", async () => {
    const report = await runQualityGate("04", "仅查询能力", {
      "02": "order_id",
      "03": "状态: 已删除",
      "04": "查询",
      "06": "order_id",
    });
    expect(report.passed).toBe(false);
  });
});
