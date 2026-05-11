function esc(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function addLog(tag, msg, level = "info") {
  const root = document.getElementById("logContainer");
  const color = level === "success" ? "#2c9a58" : level === "error" ? "#d35a68" : "#5673a0";
  const line = document.createElement("div");
  line.className = "log-line";
  line.innerHTML = `<span style="color:#7f8ca5;margin-right:8px;">[${new Date().toLocaleTimeString()}]</span><span style="color:${color};font-weight:700;">${esc(tag)}</span> ${esc(msg)}`;
  root.appendChild(line);
  if (root.childElementCount > 1000) {
    root.removeChild(root.firstElementChild);
  }
  root.scrollTop = root.scrollHeight;
}

export function buildSddErrorMessage(data) {
  const code = data?.errorCode || "SDD_GENERATION_FAILED";
  const stage = data?.stage || "DETAILING";
  const lastEventAt = data?.lastEventAt ? ` lastEventAt=${data.lastEventAt}` : "";
  const msg = data?.message || "任务清单生成失败";
  return `[${code}] stage=${stage}${lastEventAt} | ${msg}`;
}
