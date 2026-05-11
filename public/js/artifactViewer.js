function esc(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function updateArtifactActionButtons(params) {
  const actions = params.currentRunState?.actions || {};
  const previewText = (document.getElementById("filePreview")?.value || "").trim();
  document.getElementById("btnApprove").disabled = !actions.canApprove;
  document.getElementById("btnReject").disabled = !actions.canReject;
  document.getElementById("btnRegenerate").disabled = !actions.canRegenerate;
  document.getElementById("btnSaveEdit").disabled = !actions.canSaveEdit || !previewText;
  params.renderWorkflowButtons();
}

export function renderFileTree(params) {
  const tree = document.getElementById("fileTree");
  const preview = document.getElementById("filePreview");
  const count = document.getElementById("artifactCount");

  if (!Array.isArray(params.files) || params.files.length === 0) {
    tree.textContent = "暂无生成文件";
    preview.value = "";
    count.textContent = "0 个";
    document.getElementById("previewName").textContent = "--";
    params.refreshActions();
    return { selectedFileId: params.selectedFileId };
  }

  if (typeof params.files[0] === "string") {
    count.textContent = `${params.files.length} 个`;
    tree.innerHTML = params.files.map((name) => `<div style="padding:6px 4px;border-bottom:1px dashed #e8eef9;">${esc(name)}</div>`).join("");
    document.getElementById("previewName").textContent = String(params.files[0] || "--");
    preview.value = params.files.join("\n");
    params.refreshActions();
    return { selectedFileId: params.selectedFileId };
  }

  const showIntermediate = params.getShowIntermediate();
  const hasSdd = params.files.some((f) => f.fileId === "07");
  const visibleFiles = (!showIntermediate && hasSdd) ? params.files.filter((f) => f.fileId === "07") : params.files;
  count.textContent = `${visibleFiles.length} 个`;

  let selectedFileId = params.selectedFileId;
  if (!selectedFileId || !visibleFiles.some((f) => f.fileId === selectedFileId)) {
    selectedFileId = visibleFiles[0]?.fileId ?? null;
  }

  const selectedModules = params.currentRunState?.selectedModules;
  tree.innerHTML = visibleFiles.map((f) => {
    const isSelectedModule = !selectedModules || selectedModules.includes(f.fileId) || f.fileId === "01" || f.fileId === "07";
    let displayStatus = esc(f.status);
    let styleModifiers = "";

    if (!isSelectedModule) {
      displayStatus = "未选配 (SKIPPED)";
      styleModifiers = "opacity: 0.4; text-decoration: line-through;";
    } else if (!selectedModules && f.fileId !== "01" && f.fileId !== "07") {
      displayStatus = "待选配 (OPTIONAL)";
      styleModifiers = "opacity: 0.6;";
    } else if (f.status === "GENERATING") {
      displayStatus = "生成中 (GENERATING) <span class='generating-dots'>...</span>";
      styleModifiers = "color: #2f5d9e; font-weight: 500;";
    }

    const active = f.fileId === selectedFileId ? "background:#eef4ff;" : "";
    const stage = f.fileId === params.currentRunState?.currentFile ? " ⭐" : "";
    const displayName = f.artifactName || f.fileId;
    return `<div data-file-id="${esc(f.fileId)}" style="padding:6px 4px;border-bottom:1px dashed #e8eef9;cursor:pointer;${active}${styleModifiers}">${esc(displayName)} · ${displayStatus}${stage}</div>`;
  }).join("");

  tree.querySelectorAll("[data-file-id]").forEach((node) => {
    node.addEventListener("click", () => {
      const nextFileId = node.getAttribute("data-file-id");
      if (nextFileId) {
        params.selectPipelineFile(nextFileId);
      }
    });
  });

  const selected = visibleFiles.find((f) => f.fileId === selectedFileId) || visibleFiles[0];
  document.getElementById("previewName").textContent = `${selected.fileId} ${selected.artifactName}`;
  params.refreshActions();
  return { selectedFileId };
}
