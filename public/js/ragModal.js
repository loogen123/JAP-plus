(function initRagModal() {
  const state = {
    kbs: [],
    selectedKb: null,
    selectedDocId: null,
    selectedDocContent: "",
    lastQueryResults: [],
    docContentCache: {},
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
      <div class="modal-card history-modal-card" style="width:min(1320px,96vw);height:min(880px,92vh);">
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
        <div class="modal-bd" style="padding:12px;display:grid;grid-template-columns:300px 320px minmax(0,1fr);gap:12px;min-height:0;overflow:hidden;">
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
              <div style="display:flex;gap:8px;align-items:center;">
                <button id="ragBtnOpenDoc" class="btn btn-light" style="padding:6px 10px;font-size:12px;" disabled>打开源文件</button>
                <button id="ragBtnDeleteDoc" class="btn btn-light" style="padding:6px 10px;font-size:12px;color:var(--red);border-color:#f1c3c3;" disabled>删除文档</button>
              </div>
            </div>
            <div id="ragDocList" class="bd" style="padding:10px;overflow:auto;min-height:0;background:#fcfdff;"></div>
          </div>

          <div class="panel" style="border-radius:12px;min-height:0;display:flex;flex-direction:column;">
            <div class="hd" style="padding:12px;">
              <div class="label" style="margin:0;font-size:14px;">检索测试</div>
              <div style="margin-top:6px;font-size:12px;color:var(--muted);line-height:1.6;">检索范围是当前知识库下的全部文档。点击结果会弹出源文件并自动定位命中片段。</div>
            </div>
            <div class="bd" style="padding:10px;display:grid;grid-template-rows:auto 1fr;gap:10px;min-height:0;">
              <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;">
                <input id="ragQueryInput" class="field" style="padding:8px 10px;font-size:13px;" placeholder="输入问题后检索">
                <button id="ragBtnQuery" class="btn btn-light" style="padding:8px 12px;font-size:13px;" disabled>搜索</button>
              </div>
              <div id="ragQueryResults" style="overflow:auto;min-height:0;"></div>
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
    document.getElementById("ragBtnCreateKb").addEventListener("click", openCreateKbModal);
    document.getElementById("ragBtnDeleteKb").addEventListener("click", () => void deleteKb());
    document.getElementById("ragBtnUpload").addEventListener("click", () => void uploadDocs());
    document.getElementById("ragBtnOpenDoc").addEventListener("click", () => void openSelectedDoc());
    document.getElementById("ragBtnDeleteDoc").addEventListener("click", () => void deleteDoc());
    document.getElementById("ragBtnBindRun").addEventListener("click", () => void bindCurrentRun());
    document.getElementById("ragBtnQuery").addEventListener("click", () => void runQuery());
    document.getElementById("ragKbSearch").addEventListener("input", () => renderKbList());

    return modal;
  }

  function ensureSourcePreviewModal() {
    let modal = document.getElementById("ragSourcePreviewModal");
    if (modal) {
      return modal;
    }
    modal = document.createElement("div");
    modal.id = "ragSourcePreviewModal";
    modal.className = "modal";
    modal.innerHTML = `
      <div class="modal-card history-modal-card" style="width:min(1100px,94vw);height:min(860px,92vh);">
        <div class="modal-hd" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div style="display:flex;flex-direction:column;min-width:0;">
            <span id="ragSourceTitle" style="font-size:18px;line-height:1.2;">源文件</span>
            <span id="ragSourceHint" style="font-size:12px;color:var(--muted);font-weight:500;">点击左侧文档或检索结果后打开</span>
          </div>
          <button id="ragSourceClose" class="btn btn-light" style="padding:6px 10px;font-size:12px;">关闭</button>
        </div>
        <div class="modal-bd" style="padding:12px;min-height:0;overflow:hidden;">
          <pre id="ragSourceContent" class="preview" style="margin:0;height:100%;max-height:none;min-height:0;font-size:13px;color:var(--text);background:#fafcff;"></pre>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeSourcePreviewModal();
      }
    });
    document.getElementById("ragSourceClose").addEventListener("click", closeSourcePreviewModal);
    return modal;
  }

  function ensureChunkPreviewModal() {
    let modal = document.getElementById("ragChunkPreviewModal");
    if (modal) {
      return modal;
    }
    modal = document.createElement("div");
    modal.id = "ragChunkPreviewModal";
    modal.className = "modal";
    modal.innerHTML = `
      <div class="modal-card history-modal-card" style="width:min(980px,92vw);height:min(760px,88vh);">
        <div class="modal-hd" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div style="display:flex;flex-direction:column;min-width:0;">
            <span id="ragChunkTitle" style="font-size:18px;line-height:1.2;">分块内容</span>
            <span id="ragChunkHint" style="font-size:12px;color:var(--muted);font-weight:500;">显示当前命中的完整分块</span>
          </div>
          <button id="ragChunkClose" class="btn btn-light" style="padding:6px 10px;font-size:12px;">关闭</button>
        </div>
        <div class="modal-bd" style="padding:12px;display:grid;grid-template-rows:auto 1fr;gap:10px;min-height:0;overflow:hidden;">
          <div id="ragChunkMeta" class="history-meta" style="padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#fafcff;font-size:12px;"></div>
          <pre id="ragChunkContent" class="preview" style="margin:0;height:100%;max-height:none;min-height:0;font-size:13px;color:var(--text);background:#fafcff;"></pre>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeChunkPreviewModal();
      }
    });
    document.getElementById("ragChunkClose").addEventListener("click", closeChunkPreviewModal);
    return modal;
  }

  function closeChunkPreviewModal() {
    const modal = document.getElementById("ragChunkPreviewModal");
    if (modal) {
      modal.classList.remove("show");
    }
  }

  function closeSourcePreviewModal() {
    const modal = document.getElementById("ragSourcePreviewModal");
    if (modal) {
      modal.classList.remove("show");
    }
  }

  function ensureCreateKbModal() {
    let modal = document.getElementById("ragCreateKbModal");
    if (modal) {
      return modal;
    }
    modal = document.createElement("div");
    modal.id = "ragCreateKbModal";
    modal.className = "modal";
    modal.innerHTML = `
      <div class="modal-card" style="width:min(520px,100%);">
        <div class="modal-hd" style="display:flex;justify-content:space-between;align-items:center;">
          <span>新建知识库</span>
          <button id="ragCreateKbClose" class="btn btn-light" style="padding:4px 10px;font-size:12px;">X</button>
        </div>
        <div class="modal-bd" style="display:grid;gap:10px;">
          <div>
            <div class="label" style="font-size:14px;margin:0 0 6px;">名称 *</div>
            <input id="ragCreateKbName" class="field" placeholder="例如：公司规范 / 领域资料" />
          </div>
          <div>
            <div class="label" style="font-size:14px;margin:0 0 6px;">描述</div>
            <textarea id="ragCreateKbDesc" class="field" style="min-height:110px;" placeholder="可选：说明这个知识库的来源、适用范围、注意事项"></textarea>
          </div>
          <div id="ragCreateKbError" style="display:none;font-size:13px;color:var(--red);"></div>
        </div>
        <div class="modal-ft" style="justify-content:flex-end;">
          <button id="ragCreateKbCancel" class="btn btn-light">取消</button>
          <button id="ragCreateKbSubmit" class="btn btn-primary">创建</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeCreateKbModal();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.classList.contains("show")) {
        closeCreateKbModal();
      }
    });

    document.getElementById("ragCreateKbClose").addEventListener("click", closeCreateKbModal);
    document.getElementById("ragCreateKbCancel").addEventListener("click", closeCreateKbModal);
    document.getElementById("ragCreateKbSubmit").addEventListener("click", () => void submitCreateKb());
    document.getElementById("ragCreateKbName").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submitCreateKb();
      }
    });

    return modal;
  }

  function openCreateKbModal() {
    const modal = ensureCreateKbModal();
    modal.classList.add("show");
    const nameInput = document.getElementById("ragCreateKbName");
    const descInput = document.getElementById("ragCreateKbDesc");
    if (nameInput) nameInput.value = "";
    if (descInput) descInput.value = "";
    setCreateKbError("");
    setTimeout(() => {
      document.getElementById("ragCreateKbName")?.focus();
    }, 0);
  }

  function closeCreateKbModal() {
    const modal = document.getElementById("ragCreateKbModal");
    if (modal) {
      modal.classList.remove("show");
    }
  }

  function setCreateKbError(message) {
    const el = document.getElementById("ragCreateKbError");
    if (!el) return;
    if (!message) {
      el.style.display = "none";
      el.textContent = "";
      return;
    }
    el.style.display = "block";
    el.textContent = message;
  }

  async function submitCreateKb() {
    const submitBtn = document.getElementById("ragCreateKbSubmit");
    const name = (document.getElementById("ragCreateKbName")?.value || "").trim();
    const description = (document.getElementById("ragCreateKbDesc")?.value || "").trim();
    if (!name) {
      setCreateKbError("名称不能为空");
      return;
    }
    setCreateKbError("");
    if (submitBtn) submitBtn.disabled = true;
    try {
      const kb = await request("/api/v1/rag/knowledge-bases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      closeCreateKbModal();
      await refreshAll();
      if (kb?.id) {
        await selectKb(kb.id);
      }
      await showNotice("创建成功", "知识库已创建，可以继续上传资料。");
    } catch (e) {
      setCreateKbError(String(e));
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
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

  function renderPreviewContent(targetId, content, highlightText) {
    const el = document.getElementById(targetId);
    if (!el) return;
    const safeContent = escapeHtml(content || "");
    if (!highlightText || !content) {
      el.innerHTML = safeContent;
      return;
    }
    const index = content.indexOf(highlightText);
    if (index < 0) {
      el.innerHTML = safeContent;
      return;
    }
    const before = escapeHtml(content.slice(0, index));
    const matched = escapeHtml(content.slice(index, index + highlightText.length));
    const after = escapeHtml(content.slice(index + highlightText.length));
    el.innerHTML = `${before}<mark class="rag-inline-highlight">${matched}</mark>${after}`;
    requestAnimationFrame(() => {
      el.querySelector(".rag-inline-highlight")?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  function findLineNumber(content, snippet) {
    if (!content || !snippet) {
      return null;
    }
    const index = content.indexOf(snippet);
    if (index < 0) {
      return null;
    }
    return content.slice(0, index).split("\n").length;
  }

  function getSelectedDoc() {
    return currentKbDocs().find((doc) => doc.id === state.selectedDocId) || null;
  }

  async function loadDocContent(docId) {
    if (!state.selectedKb) {
      return { fileName: "源文件", content: "" };
    }
    if (state.docContentCache[docId]) {
      return state.docContentCache[docId];
    }
    const data = await request(
      `/api/v1/rag/knowledge-bases/${state.selectedKb.id}/documents/${docId}/content`,
    );
    state.docContentCache[docId] = data;
    return data;
  }

  function ensureFeedbackModal() {
    let modal = document.getElementById("ragFeedbackModal");
    if (modal) {
      return modal;
    }
    modal = document.createElement("div");
    modal.id = "ragFeedbackModal";
    modal.className = "modal";
    modal.innerHTML = `
      <div class="modal-card" style="width:min(460px,100%);">
        <div class="modal-hd" id="ragFeedbackTitle">提示</div>
        <div class="modal-bd">
          <div id="ragFeedbackMessage" style="font-size:14px;line-height:1.7;color:var(--text);"></div>
        </div>
        <div class="modal-ft" id="ragFeedbackActions"></div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeFeedbackModal(false);
      }
    });
    return modal;
  }

  function closeFeedbackModal(result) {
    const modal = document.getElementById("ragFeedbackModal");
    if (modal) {
      modal.classList.remove("show");
    }
    if (typeof state.feedbackResolver === "function") {
      const resolver = state.feedbackResolver;
      state.feedbackResolver = null;
      resolver(result);
    }
  }

  function showNotice(title, message, confirmText = "知道了") {
    const modal = ensureFeedbackModal();
    setText("ragFeedbackTitle", title);
    setHtml("ragFeedbackMessage", escapeHtml(message).replace(/\n/g, "<br>"));
    setHtml(
      "ragFeedbackActions",
      `<button id="ragFeedbackOk" class="btn btn-primary">${escapeHtml(confirmText)}</button>`,
    );
    document.getElementById("ragFeedbackOk")?.addEventListener("click", () => closeFeedbackModal(true));
    modal.classList.add("show");
    return new Promise((resolve) => {
      state.feedbackResolver = resolve;
    });
  }

  function showConfirm(title, message, options) {
    const modal = ensureFeedbackModal();
    const confirmText = options?.confirmText || "确认";
    const cancelText = options?.cancelText || "取消";
    const danger = Boolean(options?.danger);
    setText("ragFeedbackTitle", title);
    setHtml("ragFeedbackMessage", escapeHtml(message).replace(/\n/g, "<br>"));
    setHtml(
      "ragFeedbackActions",
      `
        <button id="ragFeedbackCancel" class="btn btn-light">${escapeHtml(cancelText)}</button>
        <button id="ragFeedbackConfirm" class="btn ${danger ? "btn-light" : "btn-primary"}" style="${danger ? "color:var(--red);border-color:#f1c3c3;" : ""}">${escapeHtml(confirmText)}</button>
      `,
    );
    document.getElementById("ragFeedbackCancel")?.addEventListener("click", () => closeFeedbackModal(false));
    document.getElementById("ragFeedbackConfirm")?.addEventListener("click", () => closeFeedbackModal(true));
    modal.classList.add("show");
    return new Promise((resolve) => {
      state.feedbackResolver = resolve;
    });
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
    state.selectedDocContent = "";
    state.lastQueryResults = [];
    state.docContentCache = {};
    setHtml("ragQueryResults", "");
    setDisabled("ragBtnOpenDoc", true);
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

  function selectDoc(docId) {
    state.selectedDocId = docId;
    renderDocList();
    setDisabled("ragBtnOpenDoc", false);
    setDisabled("ragBtnDeleteDoc", false);
  }

  async function openDocPreview(docId, options = {}) {
    if (!state.selectedKb) return;
    const sourceModal = ensureSourcePreviewModal();
    sourceModal.classList.add("show");
    setText("ragSourceTitle", options.fileName || "源文件");
    setText(
      "ragSourceHint",
      options.fromQuery ? "正在打开命中的源文件并定位原文片段" : "正在打开源文件全文",
    );
    renderPreviewContent("ragSourceContent", "", "");
    const data = await loadDocContent(docId);
    state.selectedDocContent = data.content || "";
    const lineNumber = findLineNumber(state.selectedDocContent, options.highlightText || "");
    setText("ragSourceTitle", data.fileName || "源文件");
    setText(
      "ragSourceHint",
      options.highlightText
        ? `已定位到命中片段${lineNumber ? `，约第 ${lineNumber} 行` : ""}`
        : "显示当前源文件全文",
    );
    renderPreviewContent("ragSourceContent", state.selectedDocContent, options.highlightText || "");
  }

  async function openSelectedDoc() {
    const selectedDoc = getSelectedDoc();
    if (!selectedDoc) {
      return;
    }
    await openDocPreview(selectedDoc.id, { fileName: selectedDoc.fileName });
  }

  async function deleteKb() {
    if (!state.selectedKb) return;
    const confirmed = await showConfirm(
      "删除知识库",
      `确认删除知识库“${state.selectedKb.name || ""}”？删除后文档与索引会一起移除。`,
      { confirmText: "删除", cancelText: "取消", danger: true },
    );
    if (!confirmed) return;
    await request(`/api/v1/rag/knowledge-bases/${state.selectedKb.id}`, { method: "DELETE" });
    state.selectedKb = null;
    state.selectedDocId = null;
    state.selectedDocContent = "";
    state.lastQueryResults = [];
    state.docContentCache = {};
    setText("ragKbMetaLine", "未选择知识库");
    setHtml("ragDocList", '<div class="history-empty">请选择知识库</div>');
    setHtml("ragQueryResults", "");
    setDisabled("ragBtnUpload", true);
    setDisabled("ragBtnDeleteKb", true);
    setDisabled("ragBtnBindRun", true);
    setDisabled("ragBtnQuery", true);
    setDisabled("ragBtnOpenDoc", true);
    setDisabled("ragBtnDeleteDoc", true);
    await refreshAll();
    await showNotice("删除成功", "知识库已删除。");
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
      await selectKb(state.selectedKb.id);
      await refreshAll();
      await showNotice("导入完成", `成功 ${data.success} 个，错误 ${data.errors.length} 个。`);
    };
    input.click();
  }

  async function deleteDoc() {
    if (!state.selectedKb || !state.selectedDocId) return;
    const currentDoc = currentKbDocs().find((doc) => doc.id === state.selectedDocId);
    const confirmed = await showConfirm(
      "删除文档",
      `确认删除文档“${currentDoc?.fileName || ""}”？`,
      { confirmText: "删除", cancelText: "取消", danger: true },
    );
    if (!confirmed) return;
    await request(
      `/api/v1/rag/knowledge-bases/${state.selectedKb.id}/documents/${state.selectedDocId}`,
      { method: "DELETE" },
    );
    delete state.docContentCache[state.selectedDocId];
    state.selectedDocId = null;
    state.selectedDocContent = "";
    setDisabled("ragBtnOpenDoc", true);
    setDisabled("ragBtnDeleteDoc", true);
    await selectKb(state.selectedKb.id);
    await refreshAll();
    await showNotice("删除成功", "文档已删除。");
  }

  async function runQuery() {
    if (!state.selectedKb) return;
    const query = (document.getElementById("ragQueryInput")?.value || "").trim();
    if (!query) return;
    setHtml("ragQueryResults", '<div class="history-empty">正在检索当前知识库的全部文档...</div>');
    const results = await request(`/api/v1/rag/knowledge-bases/${state.selectedKb.id}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    state.lastQueryResults = Array.isArray(results) ? results : [];
    if (!Array.isArray(results) || results.length === 0) {
      setHtml("ragQueryResults", '<div class="history-empty">无结果，当前会检索该知识库下的全部文档。</div>');
      return;
    }
    setHtml(
      "ragQueryResults",
      results
        .map((item, index) => `
          <div class="log-line" data-action="open-query-result" data-result-index="${index}" style="margin:0 0 8px;cursor:pointer;">
            <div style="font-weight:700;color:#2f5d9e;">[${Number(item.score || 0).toFixed(2)}] ${escapeHtml(item.chunk?.metadata?.docFileName || item.source || "")}</div>
            <div class="history-meta" style="margin-top:4px;">Chunk #${Number(item.chunk?.metadata?.chunkIndex ?? 0) + 1}</div>
            <div style="margin-top:6px;color:#4b5f80;line-height:1.5;">${escapeHtml(String(item.chunk?.content || "").slice(0, 220))}...</div>
          </div>
        `)
        .join(""),
    );
  }

  function openChunkPreview(result) {
    const modal = ensureChunkPreviewModal();
    modal.classList.add("show");
    setText("ragChunkTitle", result?.chunk?.metadata?.docFileName || "分块内容");
    setText(
      "ragChunkHint",
      `Chunk #${Number(result?.chunk?.metadata?.chunkIndex ?? 0) + 1} · 显示当前检索命中的完整分块`,
    );
    setHtml(
      "ragChunkMeta",
      `
        <div><strong>来源文件：</strong>${escapeHtml(result?.chunk?.metadata?.docFileName || "")}</div>
        <div style="margin-top:4px;"><strong>分块序号：</strong>${Number(result?.chunk?.metadata?.chunkIndex ?? 0) + 1}</div>
        <div style="margin-top:4px;"><strong>相关度：</strong>${Number(result?.score || 0).toFixed(2)}</div>
      `,
    );
    setText("ragChunkContent", String(result?.chunk?.content || ""));
  }

  async function bindCurrentRun() {
    if (!state.selectedKb) return;
    const runId = document.getElementById("currentTaskId")?.textContent?.trim();
    if (!runId || runId === "--") {
      await showNotice("无法绑定", "当前没有运行中的任务。");
      return;
    }
    const workspacePath = document.getElementById("workspacePath")?.value?.trim() || "";
    const resp = await fetch(`/api/v1/tasks/filewise/${runId}/rag`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ragKbId: state.selectedKb.id, workspace: { path: workspacePath } }),
    });
    if (!resp.ok) {
      await showNotice("绑定失败", "请确认当前任务存在且工作目录配置正确。");
      return;
    }
    await showNotice("绑定成功", "知识库已绑定到当前任务。");
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
      if (docId) selectDoc(docId);
    } else if (action === "open-query-result") {
      const resultIndex = Number(target.getAttribute("data-result-index"));
      const row = state.lastQueryResults[resultIndex];
      if (row?.chunk?.docId) {
        selectDoc(row.chunk.docId);
        openChunkPreview(row);
      }
    }
  });

  window.RAG_MODAL = {
    open,
    close,
  };
})();
