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

  it("为结构化分块补充元数据", () => {
    const text = [
      "# 用户管理",
      "",
      "- 创建用户",
      "- 删除用户",
      "",
      "```ts",
      "const enabled = true;",
      "```",
    ].join("\n");

    const result = chunkText(text, "spec.md", { chunkSize: 500, minChunkSize: 20 });
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.some((item) => item.metadata.blockType === "list")).toBe(true);
    expect(result.some((item) => item.metadata.blockType === "code")).toBe(true);
    expect(result.every((item) => item.metadata.sectionTitle === "用户管理")).toBe(true);
    expect(result.every((item) => Array.isArray(item.metadata.path))).toBe(true);
  });

  it("同一章节下的多个子标题共享最近上级章节父块", () => {
    const text = [
      "# 手册",
      "总览。",
      "",
      "## 步骤 1：定义 MVP 边界",
      "步骤说明。",
      "",
      "### 要做什么？",
      "写一句核心价值主张。",
      "",
      "### 产出物",
      "范围文档。",
    ].join("\n");

    const result = chunkText(text, "guide.md", { chunkSize: 120, minChunkSize: 10, parentContextChars: 240 });
    const a = result.find((item) => item.content.includes("核心价值主张"));
    const b = result.find((item) => item.content.includes("范围文档"));

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    expect(a?.content).not.toBe(b?.content);
    expect(a?.metadata.parentPath).toEqual(["手册", "步骤 1：定义 MVP 边界"]);
    expect(b?.metadata.parentPath).toEqual(["手册", "步骤 1：定义 MVP 边界"]);
    expect(a?.metadata.parentKind).toBe("section");
    expect(b?.metadata.parentKind).toBe("section");
    expect(a?.metadata.parentTitle).toBe("步骤 1：定义 MVP 边界");
    expect(b?.metadata.parentTitle).toBe("步骤 1：定义 MVP 边界");
    expect(b?.metadata.parentContext).toContain("步骤说明");
    expect(b?.metadata.parentContext).toContain("核心价值主张");
  });

  it("无标题长文不会退化成单个空父块", () => {
    const text = [
      "第一段".repeat(120),
      "",
      "第二段".repeat(120),
      "",
      "第三段".repeat(120),
      "",
      "第四段".repeat(120),
    ].join("\n");

    const result = chunkText(text, "essay.md", {
      chunkSize: 120,
      chunkOverlap: 20,
      minChunkSize: 10,
      parentContextChars: 320,
    });

    const titleCounts = result.reduce<Record<string, number>>((acc, item) => {
      const title = typeof item.metadata.parentTitle === "string" ? item.metadata.parentTitle.trim() : "";
      if (title) {
        acc[title] = (acc[title] ?? 0) + 1;
      }
      return acc;
    }, {});
    expect(result.every((item) => item.metadata.parentKind === "cluster")).toBe(true);
    expect(Object.keys(titleCounts).length).toBeGreaterThan(1);
    expect(Object.values(titleCounts).some((count) => count > 1)).toBe(true);
  });

  it("同时保留父级上下文预览和完整父级上下文", () => {
    const text = [
      "# 手册",
      "",
      "## 步骤 1：定义 MVP 边界",
      "步骤说明。",
      "",
      "### 要做什么？",
      "写一句核心价值主张。",
      "",
      "### 产出物",
      "范围文档。",
    ].join("\n");

    const result = chunkText(text, "guide.md", {
      chunkSize: 120,
      minChunkSize: 10,
      parentContextChars: 12,
    });
    const target = result.find((item) => item.content.includes("范围文档"));

    expect(target?.metadata.parentContext).toBe("步骤说明。\n\n写一句核心");
    expect(target?.metadata.parentFullContext).toContain("步骤说明。");
    expect(target?.metadata.parentFullContext).toContain("写一句核心价值主张。");
    expect(target?.metadata.parentFullContext).toContain("范围文档。");
  });

  it("为子块保留父路径与父上下文", () => {
    const text = [
      "# 总览",
      "系统负责统一调度任务。",
      "",
      "## 检索流程",
      "先扩展查询，再融合排序，最后注入上下文。",
      "",
      "- 扩展查询",
      "- 候选融合",
    ].join("\n");

    const result = chunkText(text, "plan.md", {
      chunkSize: 120,
      minChunkSize: 20,
      parentContextChars: 120,
    });

    const retrievalChunk = result.find((item) => item.content.includes("先扩展查询"));
    expect(retrievalChunk?.metadata.sectionTitle).toBe("检索流程");
    expect(retrievalChunk?.metadata.parentPath).toEqual(["总览"]);
    expect(retrievalChunk?.metadata.parentTitle).toBe("总览");
    expect(retrievalChunk?.metadata.parentContext).toContain("系统负责统一调度任务");
    expect(retrievalChunk?.metadata.parentContext).toContain("先扩展查询");
    expect(typeof retrievalChunk?.metadata.childIndexInParent).toBe("number");
  });

  it("混合父块时仍按原文顺序输出并连续编号 chunkIndex", () => {
    const text = [
      "# 手册",
      "总览。",
      "",
      "## 步骤 1",
      "步骤 1 导语。",
      "",
      "### 要做什么",
      "写一句核心价值主张。",
      "",
      "### 产出物",
      "范围文档。",
      "",
      "## 步骤 2",
      "步骤 2 导语。",
    ].join("\n");

    const result = chunkText(text, "guide.md", {
      chunkSize: 120,
      minChunkSize: 10,
      parentContextChars: 240,
    });

    expect(result.map((item) => item.content)).toEqual([
      "总览。",
      "步骤 1 导语。",
      "写一句核心价值主张。",
      "范围文档。",
      "步骤 2 导语。",
    ]);
    expect(result.map((item) => item.metadata.chunkIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("标题只用于构造父块上下文，不直接输出为孤立叶子块", () => {
    const text = ["# 第一章", "正文A", "", "## 第二节", "正文B"].join("\n");
    const result = chunkText(text, "doc.md", { chunkSize: 120, minChunkSize: 10 });
    expect(result.some((item) => item.content === "# 第一章")).toBe(false);
    expect(result.every((item) => item.metadata.parentPath?.length)).toBeTruthy();
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

  it("不会跨章节合并极短分块", () => {
    const text = ["# 第一章", "短", "", "# 第二章", "另一个短段落"].join("\n");
    const result = chunkText(text, "split.md", { chunkSize: 500, minChunkSize: 50 });
    expect(result).toHaveLength(2);
    expect(result[0]?.metadata.sectionTitle).toBe("第一章");
    expect(result[1]?.metadata.sectionTitle).toBe("第二章");
  });
});
