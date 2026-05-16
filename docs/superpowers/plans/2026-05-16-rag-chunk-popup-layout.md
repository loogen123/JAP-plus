# RAG Chunk Popup Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把分块弹窗改成父模块大、子模块小的上下分栏布局，并让两块内容都可独立滚动查看完整内容。

**Architecture:** 保留现有分块元数据和打开源文件逻辑，只重构弹窗 DOM 结构与渲染目标。元信息保持紧凑，父级上下文迁移为独立大面板，子块内容保留为较小下方面板。

**Tech Stack:** JavaScript, Vitest

---
