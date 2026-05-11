export async function fetchTasksSourceRuns(apiBase, workspacePath) {
  const query = workspacePath ? `?workspacePath=${encodeURIComponent(workspacePath)}` : "";
  const apiPath = "/api/v1/sources/sdd/global";
  const resp = await fetch(apiBase + `${apiPath}${query}`, { cache: "no-store" });
  const data = await resp.json();
  return { ok: resp.ok, data };
}

export async function fetchHistoryRequirements(apiBase, workspacePath) {
  const queryParts = [];
  if (workspacePath) queryParts.push(`workspacePath=${encodeURIComponent(workspacePath)}`);
  queryParts.push(`_ts=${Date.now()}`);
  const query = `?${queryParts.join("&")}`;
  const resp = await fetch(apiBase + `/api/v1/history/requirements${query}`, { cache: "no-store" });
  const data = await resp.json();
  return { ok: resp.ok, data };
}

export async function fetchHistoryRequirementById(apiBase, id, type, workspacePath) {
  const queryParts = [];
  if (type) queryParts.push(`type=${encodeURIComponent(type)}`);
  if (workspacePath) queryParts.push(`workspacePath=${encodeURIComponent(workspacePath)}`);
  queryParts.push(`_ts=${Date.now()}`);
  const query = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";
  const resp = await fetch(apiBase + `/api/v1/history/requirements/${encodeURIComponent(id)}${query}`, { cache: "no-store" });
  const data = await resp.json();
  return { ok: resp.ok, data };
}
