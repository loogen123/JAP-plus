# RAG Parent Full Context Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让分块弹窗显示完整父级上下文，同时不改变现有注入和轻量展示使用的短预览上下文。

**Architecture:** 在分块元数据中新增完整父级上下文字段，保留现有 `parentContext` 作为短预览。前端弹窗优先展示完整字段，缺失时回退到短预览，保证老索引兼容。

**Tech Stack:** TypeScript, Node.js, Vitest

---

## File Map

- Modify: `src/rag/types.ts`
- Modify: `src/rag/chunking/index.ts`
- Modify: `public/js/ragModal.js`
- Modify: `src/tests/unit/rag-chunking.test.ts`
- Modify: `src/tests/unit/rag-ui.test.ts`
