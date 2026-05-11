import { describe, expect, it } from "vitest";
import { chunkText } from "../../rag/chunking/index.js";

describe("chunkText", () => {
  it("空文本返回空数组", () => {
    expect(chunkText("", "test.md")).toEqual([]);
    expect(chunkText("   \n\n  ", "test.md")).toEqual([]);
  });

  it("短文本返回单个分块", () => {
    const result = chunkText("用户登录功能需求", "test.md");
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe("用户登录功能需求");
    expect(result[0]?.metadata.docFileName).toBe("test.md");
    expect(result[0]?.metadata.chunkIndex).toBe(0);
  });

  it("按 Markdown 标题边界切分", () => {
    const text = ["# 用户管理", "用户可以注册和登录系统。", "", "## 认证机制", "采用 JWT Token 认证方式。"].join("\n");
    const result = chunkText(text, "spec.md");
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("超长文本产生多个分块且包含重叠", () => {
    const longText = "A".repeat(5000);
    const result = chunkText(longText, "long.txt", { chunkSize: 500, chunkOverlap: 50 });
    expect(result.length).toBeGreaterThan(1);
    const firstEnd = result[0]?.content.slice(-30) ?? "";
    const secondStart = result[1]?.content.slice(0, 30) ?? "";
    expect(secondStart).toContain(firstEnd.slice(-20));
  });

  it("极短分块被合并到前一个", () => {
    const text = ["# 第一章", "A".repeat(2000), "", "# 第二章", "短"].join("\n");
    const result = chunkText(text, "short.md", { chunkSize: 500, minChunkSize: 50 });
    const last = result[result.length - 1]?.content ?? "";
    expect(last).toContain("短");
  });
});
