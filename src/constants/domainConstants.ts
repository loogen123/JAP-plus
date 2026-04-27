export const QUESTION_DIMENSIONS = {
  core: "\u6838\u5fc3\u5b9e\u4f53",
  state: "\u72b6\u6001\u8fb9\u754c",
  security: "\u5b89\u5168\u6743\u9650",
  dependency: "\u5916\u90e8\u4f9d\u8d56",
} as const;

export const ARTIFACT_FILES = {
  modeling01: "01_\u9700\u6c42\u7b80\u62a5.md",
  modeling02: "02_\u9886\u57df\u8bcd\u5178.md",
  modeling03: "03_\u884c\u4e3a\u89c4\u5219.md",
  modeling04: "04_\u80fd\u529b\u610f\u56fe.md",
  detailing05: "05_Agent\u6267\u884c\u6307\u5357.md",
  detailing06: "06_\u9a8c\u6536\u6e05\u5355.md",
  sdd07: "07_SDD\u7ea6\u675f\u603b\u89c8.md",
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
