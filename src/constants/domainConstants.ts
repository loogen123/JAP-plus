export const QUESTION_DIMENSIONS = {
  core: "\u6838\u5fc3\u5b9e\u4f53",
  state: "\u72b6\u6001\u8fb9\u754c",
  security: "\u5b89\u5168\u6743\u9650",
  dependency: "\u5916\u90e8\u4f9d\u8d56",
} as const;

export const ARTIFACT_FILES = {
  modeling01: "01_\u4ea7\u54c1\u529f\u80fd\u8111\u56fe\u4e0e\u7528\u4f8b.md",
  modeling02: "02_\u9886\u57df\u6a21\u578b\u4e0e\u7269\u7406\u8868\u7ed3\u6784.md",
  modeling03: "03_\u6838\u5fc3\u4e1a\u52a1\u72b6\u6001\u673a.md",
  modeling04: "04_RESTful_API\u5951\u7ea6.yaml",
  detailing05: "05_UI\u539f\u578b\u4e0e\u4ea4\u4e92\u8349\u56fe.html",
  detailing06: "06_API\u8c03\u8bd5\u96c6\u5408.json",
  sdd07: "07_Actionable_Tasks.md",
} as const;

export const MODELING_ARTIFACT_KEYS = [
  ARTIFACT_FILES.modeling01,
  ARTIFACT_FILES.modeling02,
  ARTIFACT_FILES.modeling03,
  ARTIFACT_FILES.modeling04,
] as const;

export const FILEWISE_STATUS_ORDER = [
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
] as const;
