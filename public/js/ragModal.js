(function initRagModal() {
  const state = {
    kbs: [],
    selectedKb: null,
    selectedDocId: null,
  };

  function escapeHtml(input) {
    const div = document.createElement("div");
    div.textContent = String(input ?? "");
    return div.innerHTML;
  }

  async function request(url, options) {
    const resp = await fetch(url, options);
    const json = await resp.json();
    if (!resp.ok || json.code !== 0) {
      throw new Error(json.message || "request failed");
    }
    return json.data;
  }

  function bufferToBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function ensureModal() {
    let modal = document.getElementById("ragModal");
    if (modal) {
      return modal;
    }
    modal = document.createElement("div");
    modal.id = "ragModal";
    modal.className = "modal";
    modal.innerHTML = `
      <div class="modal-card history-modal-card" style="width:min(1180px,100%);">
        <div class="modal-hd" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div style="display:flex;flex-direction:column;">
            <span style="font-size:18px;">知识库</span>
            <span id="ragKbMetaLine" style="font-size:12px;color:var(--muted);font-weight:500;">未选择知识库</span>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
            <button id="ragBtnCreateKb" class="btn btn-light" style="padding:6px 10px;font-size:12px;">新建</button>
            <button id="ragBtnUpload" class="btn btn-light" style="padding:6px 10px;font-size:12px;" disabled>上传</button>
            <button id="ragBtnBindRun" class="btn btn-light" style="padding:6px 10px;font-size:12px;" disabled>绑定当前任务</button>
            <button id="ragBtnDeleteKb" class="btn btn-light" style="padding:6px 10px;font-size:12px;color:var(--red);border-color:#f1c3c3;" disabled>删除</button>
            <button id="ragBtnClose" class="btn btn-light" style="padding:6px 10px;font-size:12px;">关闭</button>
          </div>
        </div>
        <div class="modal-bd" style="padding:10px 12px;display:grid;grid-template-columns:280px 300px 1fr;gap:12px;min-height:0;overflow:hidden;">
          <div class="panel" style="border-radius:12px;min-height:0;display:flex;flex-direction:column;">
            <div class="hd" style="padding:12px;">
              <div class="label" style="margin:0;font-size:14px;">知识库列表</div>
              <input id="ragKbSearch" class="field" style="margin-top:8px;padding:8px 10px;font-size:13px;" placeholder="搜索名称">
            </div>
            <div id="ragKbList" class="bd" style="padding:10px;overflow:auto;min-height:0;display:flex;flex-direction:column;gap:8px;background:#fcfdff;"></div>
          </div>

          <div class="panel" style="border-radius:12px;min-height:0;display:flex;flex-direction:column;">
            <div class="hd" style="padding:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <div class="label" style="margin:0;font-size:14px;">文档</div>
              <button id="ragBtnDeleteDoc" class="btn btn-light" style="padding:6px 10px;font-size:12px;color:var(--red);border-color:#f1c3c3;" disabled>删除文档</button>
            </div>
            <div id="ragDocList" class="bd" style="padding:10px;overflow:auto;min-height:0;background:#fcfdff;"></div>
          </div>

          <div class="panel" style="border-radius:12px;min-height:0;display:flex;flex-direction:column;">
            <div class="hd" style="padding:12px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
              <div style="display:flex;flex-direction:column;gap:2px;">
                <div id="ragDocTitle" class="label" style="margin:0;font-size:14px;">内容预览</div>
                <div id="ragDocHint" style="font-size:12px;color:var(--muted);">选择左侧文档查看内容</div>
              </div>
            </div>
            <div class="bd" style="padding:10px;display:grid;grid-template-rows:1fr auto;gap:10px;min-height:0;">
              <pre id="ragDocContent" class="preview" style="margin:0;min-height:0;max-height:none;height:100%;font-size:13px;color:var(--text);background:#fafcff;"></pre>
              <div style="border-top:1px solid var(--line);padding-top:10px;">
                <div class="label" style="margin:0 0 8px;font-size:14px;">检索测试</div>
                <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;">
                  <input id="ragQueryInput" class="field" style="padding:8px 10px;font-size:13px;" placeholder="输入问题后检索">
                  <button id="ragBtnQuery" class="btn btn-light" style="padding:8px 12px;font-size:13px;" disabled>搜索</button>
                </div>
                <div id="ragQueryResults" style="margin-top:10px;max-height:160px;overflow:auto;"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        close();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("show")) {
        close();
      }
    });

    document.getElementById("ragBtnClose").addEventListener("click", close);
    document.getElementById("ragBtnCreateKb").addEventListener("click", () => void createKb());
    document.getElementById("ragBtnDeleteKb").addEventListener("click", () => void deleteKb());
    document.getElementById("ragBtnUpload").addEventListener("click", () => void uploadDocs());
    document.getElementById("ragBtnDeleteDoc").addEventListener("click", () => void deleteDoc());
    document.getElementById("ragBtnBindRun").addEventListener("click", () => void bindCurrentRun());
    document.getElementById("ragBtnQuery").addEventListener("click", () => void runQuery());
    document.getElementById("ragKbSearch").addEventListener("input", () => renderKbList());

    return modal;
  }

  function open() {
    const modal = ensureModal();
    modal.classList.add("show");
    return refreshAll();
  }

  function close() {
    const modal = document.getElementById("ragModal");
    if (modal) {
      modal.classList.remove("show");
    }
  }

  function setDisabled(id, disabled) {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function setHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  function currentKbDocs() {
    return (state.selectedKb && Array.isArray(state.selectedKb.documents)) ? state.selectedKb.documents : [];
  }

  async function loadKbList() {
    state.kbs = await request("/api/v1/rag/knowledge-bases");
  }

  function renderKbList() {
    const keyword = (document.getElementById("ragKbSearch")?.value || "").trim().toLowerCase();
    const list = (state.kbs || []).filter((kb) => !keyword || String(kb.name || "").toLowerCase().includes(keyword));
    if (list.length === 0) {
      setHtml("ragKbList", '<div class="history-empty">暂无知识库</div>');
      return;
    }
    setHtml(
      "ragKbList",
      list
        .map((kb) => {
          const active = state.selectedKb && state.selectedKb.id === kb.id;
          return `
            <div class="history-item ${active ? "active" : ""}" style="border-radius:10px;border:1px solid var(--line);background:#fff;cursor:pointer;" data-action="select-kb" data-kb-id="${kb.id}">
              <div style="font-weight:700;color:var(--text);font-size:14px;line-height:1.2;">${escapeHtml(kb.name)}</div>
              <div class="history-meta" style="margin-top:6px;">${kb.documentCount} 文档 · ${kb.chunkCount} 分块</div>
            </div>
          `;
        })
        .join(""),
    );
  }

  function renderDocList() {
    const docs = currentKbDocs();
    if (!state.selectedKb) {
      setHtml("ragDocList", '<div class="history-empty">请选择知识库</div>');
      return;
    }
    if (!docs || docs.length === 0) {
      setHtml("ragDocList", '<div class="history-empty">暂无文档</div>');
      return;
    }
    setHtml(
      "ragDocList",
      docs
        .map((doc) => {
          const active = state.selectedDocId === doc.id;
          return `
            <div class="history-item ${active ? "active" : ""}" style="border-radius:10px;border:1px solid var(--line);background:#fff;cursor:pointer;" data-action="select-doc" data-doc-id="${doc.id}">
              <div style="font-weight:700;color:var(--text);font-size:13px;line-height:1.2;">${escapeHtml(doc.fileName)}</div>
              <div class="history-meta" style="margin-top:6px;">${escapeHtml(doc.fileType || "")}</div>
            </div>
          `;
        })
        .join(""),
    );
  }

  async function selectKb(kbId) {
    state.selectedDocId = null;
    setText("ragDocTitle", "内容预览");
    setText("ragDocHint", "选择左侧文档查看内容");
    setText("ragDocContent", "");
    setHtml("ragQueryResults", "");
    setDisabled("ragBtnDeleteDoc", true);
    const kb = await request(`/api/v1/rag/knowledge-bases/${kbId}`);
    state.selectedKb = kb;
    setText("ragKbMetaLine", `${kb.name || "知识库"} · ${kb.documentCount ?? 0} 文档 · ${kb.chunkCount ?? 0} 分块`);
    setDisabled("ragBtnUpload", false);
    setDisabled("ragBtnDeleteKb", false);
    setDisabled("ragBtnBindRun", false);
    setDisabled("ragBtnQuery", false);
    renderKbList();
    renderDocList();
  }

  async function selectDoc(docId) {
    if (!state.selectedKb) return;
    state.selectedDocId = docId;
    renderDocList();
    setDisabled("ragBtnDeleteDoc", false);
    setText("ragDocTitle", "加载中...");
    setText("ragDocHint", "");
    setText("ragDocContent", "");
    const data = await request(
      `/api/v1/rag/knowledge-bases/${state.selectedKb.id}/documents/${docId}/content`,
    );
    setText("ragDocTitle", data.fileName || "内容预览");
    setText("ragDocContent", data.content || "");
  }

  async function createKb() {
    const name = prompt("知识库名称");
    if (!name) return;
    const description = prompt("描述（可选）") || "";
    await request("/api/v1/rag/knowledge-bases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
    await refreshAll();
  }

  async function deleteKb() {
    if (!state.selectedKb) return;
    if (!confirm("确认删除知识库？")) return;
    await request(`/api/v1/rag/knowledge-bases/${state.selectedKb.id}`, { method: "DELETE" });
    state.selectedKb = null;
    state.selectedDocId = null;
    setText("ragKbMetaLine", "未选择知识库");
    setText("ragDocTitle", "内容预览");
    setText("ragDocHint", "选择左侧文档查看内容");
    setText("ragDocContent", "");
    setHtml("ragDocList", '<div class="history-empty">请选择知识库</div>');
    setHtml("ragQueryResults", "");
    setDisabled("ragBtnUpload", true);
    setDisabled("ragBtnDeleteKb", true);
    setDisabled("ragBtnBindRun", true);
    setDisabled("ragBtnQuery", true);
    setDisabled("ragBtnDeleteDoc", true);
    await refreshAll();
  }

  async function uploadDocs() {
    if (!state.selectedKb) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".md,.txt,.pdf,.docx,.ts,.js,.json,.yaml,.yml,.py,.java,.go,.rs";
    input.onchange = async () => {
      if (!input.files || input.files.length === 0) return;
      const files = [];
      for (const file of input.files) {
        const isBinary = /\.(pdf|docx)$/i.test(file.name);
        if (isBinary) {
          const arrayBuffer = await file.arrayBuffer();
          files.push({
            fileName: file.name,
            contentBase64: bufferToBase64(arrayBuffer),
            encoding: "base64",
          });
        } else {
          files.push({ fileName: file.name, content: await file.text() });
        }
      }
      const data = await request(`/api/v1/rag/knowledge-bases/${state.selectedKb.id}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      alert(`导入完成：成功 ${data.success}，错误 ${data.errors.length}`);
      await selectKb(state.selectedKb.id);
      await refreshAll();
    };
    input.click();
  }

  async function deleteDoc() {
    if (!state.selectedKb || !state.selectedDocId) return;
    if (!confirm("确认删除该文档？")) return;
    await request(
      `/api/v1/rag/knowledge-bases/${state.selectedKb.id}/documents/${state.selectedDocId}`,
      { method: "DELETE" },
    );
    state.selectedDocId = null;
    setDisabled("ragBtnDeleteDoc", true);
    setText("ragDocTitle", "内容预览");
    setText("ragDocHint", "选择左侧文档查看内容");
    setText("ragDocContent", "");
    await selectKb(state.selectedKb.id);
    await refreshAll();
  }

  async function runQuery() {
    if (!state.selectedKb) return;
    const query = (document.getElementById("ragQueryInput")?.value || "").trim();
    if (!query) return;
    setHtml("ragQueryResults", '<div class="history-empty">搜索中...</div>');
    const results = await request(`/api/v1/rag/knowledge-bases/${state.selectedKb.id}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!Array.isArray(results) || results.length === 0) {
      setHtml("ragQueryResults", '<div class="history-empty">无结果</div>');
      return;
    }
    setHtml(
      "ragQueryResults",
      results
        .map((item) => `
          <div class="log-line" style="margin:0 0 8px;">
            <div style="font-weight:700;color:#2f5d9e;">[${Number(item.score || 0).toFixed(2)}] ${escapeHtml(item.source || "")}</div>
            <div style="margin-top:6px;color:#4b5f80;line-height:1.5;">${escapeHtml(String(item.chunk?.content || "").slice(0, 220))}...</div>
          </div>
        `)
        .join(""),
    );
  }

  async function bindCurrentRun() {
    if (!state.selectedKb) return;
    const runId = document.getElementById("currentTaskId")?.textContent?.trim();
    if (!runId || runId === "--") {
      alert("当前没有运行中的任务");
      return;
    }
    const workspacePath = document.getElementById("workspacePath")?.value?.trim() || "";
    const resp = await fetch(`/api/v1/tasks/filewise/${runId}/rag`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ragKbId: state.selectedKb.id, workspace: { path: workspacePath } }),
    });
    if (!resp.ok) {
      alert("绑定失败");
      return;
    }
    alert("已绑定当前任务");
  }

  async function refreshAll() {
    await loadKbList();
    renderKbList();
    if (state.selectedKb && state.selectedKb.id) {
      const still = state.kbs.find((kb) => kb.id === state.selectedKb.id);
      if (still) {
        await selectKb(state.selectedKb.id);
        return;
      }
      state.selectedKb = null;
      state.selectedDocId = null;
    }
    renderDocList();
    return;
  }

  document.addEventListener("click", (event) => {
    const modal = document.getElementById("ragModal");
    if (!modal || !modal.classList.contains("show")) return;
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.getAttribute("data-action");
    if (action === "select-kb") {
      const kbId = target.getAttribute("data-kb-id");
      if (kbId) void selectKb(kbId);
    } else if (action === "select-doc") {
      const docId = target.getAttribute("data-doc-id");
      if (docId) void selectDoc(docId);
    }
  });

  window.RAG_MODAL = {
    open,
    close,
  };
})();
