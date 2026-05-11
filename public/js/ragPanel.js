(function initRagPanel() {
  const state = {
    kbs: [],
    selectedKbId: null,
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

  function setDetail(html) {
    const detail = document.getElementById("rag-kb-detail");
    if (detail) {
      detail.innerHTML = html;
    }
  }

  function renderKBList() {
    const container = document.getElementById("rag-kb-list");
    if (!container) {
      return;
    }
    if (state.kbs.length === 0) {
      container.innerHTML = '<div class="text-gray-400 text-sm p-2">暂无知识库</div>';
      return;
    }
    container.innerHTML = state.kbs.map((kb) => `
      <div class="rag-kb-item flex items-center justify-between p-2 rounded border ${state.selectedKbId === kb.id ? "border-blue-300 bg-blue-50" : "border-gray-200"}">
        <div class="flex-1 min-w-0 cursor-pointer" data-rag-action="select-kb" data-kb-id="${kb.id}">
          <div class="text-sm font-medium truncate">${escapeHtml(kb.name)}</div>
          <div class="text-xs text-gray-500">${kb.documentCount} 文档，${kb.chunkCount} 分块</div>
        </div>
        <button class="text-red-500 text-xs ml-2" data-rag-action="delete-kb" data-kb-id="${kb.id}">删除</button>
      </div>
    `).join("");
  }

  async function loadKBList() {
    state.kbs = await request("/api/v1/rag/knowledge-bases");
    renderKBList();
  }

  async function selectKB(kbId) {
    state.selectedKbId = kbId;
    renderKBList();
    const kb = await request(`/api/v1/rag/knowledge-bases/${kbId}`);
    const docs = kb.documents || [];
    setDetail(`
      <div class="p-3">
        <div class="flex gap-2 mb-2">
          <button class="px-3 py-1 bg-blue-500 text-white text-xs rounded" data-rag-action="upload-doc">上传文档</button>
          <button class="px-3 py-1 bg-gray-200 text-xs rounded" data-rag-action="bind-run" data-kb-id="${kb.id}">绑定当前任务</button>
        </div>
        <div class="text-xs text-gray-600 mb-1">文档 (${docs.length})</div>
        <div class="max-h-40 overflow-y-auto border border-gray-200 rounded">
          ${docs.map((doc) => `
            <div class="flex items-center justify-between px-2 py-1 border-b border-gray-100 text-xs">
              <span class="truncate">${escapeHtml(doc.fileName)}</span>
              <button class="text-red-500" data-rag-action="delete-doc" data-doc-id="${doc.id}">&times;</button>
            </div>
          `).join("")}
        </div>
        <div class="mt-3">
          <div class="text-xs text-gray-600 mb-1">检索测试</div>
          <div class="flex gap-1">
            <input id="rag-query-input" class="flex-1 border border-gray-300 rounded px-2 py-1 text-xs" placeholder="输入问题">
            <button class="px-2 py-1 bg-gray-200 text-xs rounded" data-rag-action="query">搜索</button>
          </div>
          <div id="rag-query-results" class="mt-2 text-xs"></div>
        </div>
      </div>
    `);
  }

  async function createKB() {
    const name = prompt("知识库名称");
    if (!name) {
      return;
    }
    const description = prompt("描述（可选）") || "";
    await request("/api/v1/rag/knowledge-bases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
    await loadKBList();
  }

  async function deleteKB(kbId) {
    if (!confirm("确认删除知识库？")) {
      return;
    }
    await request(`/api/v1/rag/knowledge-bases/${kbId}`, { method: "DELETE" });
    if (state.selectedKbId === kbId) {
      state.selectedKbId = null;
      setDetail("");
    }
    await loadKBList();
  }

  async function uploadDocs() {
    if (!state.selectedKbId) {
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".md,.txt,.pdf,.docx,.ts,.js,.json,.yaml,.yml,.py,.java,.go,.rs";
    input.onchange = async () => {
      if (!input.files || input.files.length === 0) {
        return;
      }
      const files = [];
      const bufferToBase64 = (arrayBuffer) => {
        const bytes = new Uint8Array(arrayBuffer);
        const chunkSize = 0x8000;
        let binary = "";
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
      };
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
          const content = await file.text();
          files.push({ fileName: file.name, content });
        }
      }
      const data = await request(`/api/v1/rag/knowledge-bases/${state.selectedKbId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      alert(`导入完成：成功 ${data.success}，错误 ${data.errors.length}`);
      await loadKBList();
      await selectKB(state.selectedKbId);
    };
    input.click();
  }

  async function removeDoc(docId) {
    if (!state.selectedKbId) {
      return;
    }
    await request(`/api/v1/rag/knowledge-bases/${state.selectedKbId}/documents/${docId}`, {
      method: "DELETE",
    });
    await loadKBList();
    await selectKB(state.selectedKbId);
  }

  async function testQuery() {
    if (!state.selectedKbId) {
      return;
    }
    const queryInput = document.getElementById("rag-query-input");
    const container = document.getElementById("rag-query-results");
    if (!queryInput || !container) {
      return;
    }
    const query = queryInput.value.trim();
    if (!query) {
      return;
    }
    container.innerHTML = '<span class="text-gray-400">搜索中...</span>';
    const results = await request(`/api/v1/rag/knowledge-bases/${state.selectedKbId}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!Array.isArray(results) || results.length === 0) {
      container.innerHTML = '<span class="text-gray-400">无结果</span>';
      return;
    }
    container.innerHTML = results.map((item) => `
      <div class="mb-1 p-2 border border-gray-200 rounded bg-gray-50">
        <div><span class="text-blue-600">[${Number(item.score || 0).toFixed(2)}]</span> ${escapeHtml(item.source || "")}</div>
        <div class="text-gray-600">${escapeHtml(String(item.chunk?.content || "").slice(0, 120))}...</div>
      </div>
    `).join("");
  }

  async function bindCurrentRun(kbId) {
    const runId = document.getElementById("currentTaskId")?.textContent?.trim();
    if (!runId || runId === "--") {
      alert("当前没有运行中的任务");
      return;
    }
    const workspacePath = document.getElementById("workspacePath")?.value?.trim() || "";
    await fetch(`/api/v1/tasks/filewise/${runId}/rag`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ragKbId: kbId, workspace: { path: workspacePath } }),
    });
    alert("已绑定当前任务");
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-rag-action]");
    if (!target) {
      return;
    }
    const action = target.getAttribute("data-rag-action");
    const kbId = target.getAttribute("data-kb-id");
    const docId = target.getAttribute("data-doc-id");
    if (action === "select-kb" && kbId) {
      void selectKB(kbId);
    } else if (action === "create-kb") {
      void createKB();
    } else if (action === "delete-kb" && kbId) {
      void deleteKB(kbId);
    } else if (action === "upload-doc") {
      void uploadDocs();
    } else if (action === "delete-doc" && docId) {
      void removeDoc(docId);
    } else if (action === "query") {
      void testQuery();
    } else if (action === "bind-run" && kbId) {
      void bindCurrentRun(kbId);
    }
  });

  window.RAG_PANEL = {
    open: async () => {
      document.getElementById("rag-panel")?.classList.remove("hidden");
      await loadKBList();
    },
    close: () => {
      document.getElementById("rag-panel")?.classList.add("hidden");
    },
    loadKBList,
  };
})();
