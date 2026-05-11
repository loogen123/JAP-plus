function esc(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizeQuestionText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s\r\n\t]+/g, "")
    .replace(/[，。！？、,.!?;；:："'“”‘’（）()【】\[\]{}<>《》\-—_]/g, "");
}

export function questionSignature(question) {
  const options = Array.isArray(question?.options) ? [...question.options].map(normalizeQuestionText).sort().join("|") : "";
  const strict = `${question?.dimension || ""}#${question?.questionType || ""}#${normalizeQuestionText(question?.questionText || "")}#${options}`;
  const loose = `${question?.dimension || ""}#${question?.questionType || ""}#${normalizeQuestionText(question?.questionText || "")}`;
  return { strict, loose };
}

export function mergeQuestions(currentQuestions, newQuestions) {
  if (!Array.isArray(newQuestions) || newQuestions.length === 0) {
    return { questions: currentQuestions, added: 0 };
  }
  const merged = Array.isArray(currentQuestions) ? [...currentQuestions] : [];
  const exists = new Set();
  merged.forEach((item) => {
    const sig = questionSignature(item);
    exists.add(sig.strict);
    exists.add(sig.loose);
  });
  let added = 0;
  newQuestions.forEach((item) => {
    const sig = questionSignature(item);
    if (!sig.loose || exists.has(sig.strict) || exists.has(sig.loose)) return;
    exists.add(sig.strict);
    exists.add(sig.loose);
    merged.push(item);
    added += 1;
  });
  return { questions: merged, added };
}

export function renderCurrentQuestionView(params) {
  const qs = params.activeQuestionnaire || [];
  if (params.questionnaireLoading) {
    document.getElementById("questionProgress").textContent = "正在生成问卷...";
    document.getElementById("questionTitle").textContent = "正在准备澄清问题，请稍候";
    document.getElementById("questionDimension").textContent = "系统正在读取项目上下文并生成问题";
    document.getElementById("questionType").textContent = "";
    document.getElementById("questionOptions").innerHTML = '<div style="font-size:13px;color:var(--muted);line-height:1.8;">已启动后台思考流程，题目将分批加载到窗口。</div>';
    document.getElementById("prevQuestionBtn").style.display = "none";
    document.getElementById("nextQuestionBtn").style.display = "none";
    document.getElementById("finishQuestionBtn").style.display = "none";
    return;
  }
  if (qs.length === 0) {
    document.getElementById("questionProgress").textContent = "正在加载题目...";
    document.getElementById("questionTitle").textContent = "请稍候";
    document.getElementById("questionDimension").textContent = "";
    document.getElementById("questionType").textContent = "";
    document.getElementById("questionOptions").innerHTML = '<div style="font-size:13px;color:var(--muted);">题目将很快显示。</div>';
    document.getElementById("prevQuestionBtn").style.display = "none";
    document.getElementById("nextQuestionBtn").style.display = "none";
    document.getElementById("finishQuestionBtn").style.display = "none";
    return;
  }

  const q = qs[params.questionIndex];
  document.getElementById("questionProgress").textContent = `第 ${params.questionIndex + 1} / ${qs.length} 题`;
  document.getElementById("questionTitle").textContent = q.questionText;
  document.getElementById("questionDimension").textContent = `维度：${q.dimension}`;
  const type = q.questionType === "multiple" ? "multiple" : "single";
  document.getElementById("questionType").textContent = `题型：${type === "multiple" ? "多选" : "单选"}`;
  if (type === "single" && typeof params.answers[q.id] !== "string") {
    params.answers[q.id] = q.options[0];
  }
  if (type === "multiple" && !Array.isArray(params.answers[q.id])) {
    params.answers[q.id] = [];
  }
  const selectedSingle = typeof params.answers[q.id] === "string" ? params.answers[q.id] : q.options[0];
  const selectedMulti = Array.isArray(params.answers[q.id]) ? params.answers[q.id] : [];
  const customList = params.customAnswers[q.id] || [];
  const optionsHtml = q.options.map((opt) => {
    const escapedQid = q.id.replace(/'/g, "\\'");
    const escapedOpt = opt.replace(/'/g, "\\'");
    if (type === "multiple") {
      return `<label class="q-option"><input type="checkbox" name="modal_q_${q.id}" value="${esc(opt)}" ${selectedMulti.includes(opt) ? "checked" : ""} onchange="toggleModalAnswer('${escapedQid}','${escapedOpt}',this.checked)"/> <span>${esc(opt)}</span></label>`;
    }
    return `<label class="q-option"><input type="radio" name="modal_q_${q.id}" value="${esc(opt)}" ${selectedSingle === opt ? "checked" : ""} onchange="setModalAnswer('${escapedQid}','${escapedOpt}')"/> <span>${esc(opt)}</span></label>`;
  }).join("");
  const escapedQid = q.id.replace(/'/g, "\\'");
  const customListHtml = customList.map((item) => {
    const escapedItem = String(item).replace(/'/g, "\\'");
    return `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;"><span style="font-size:12px;padding:2px 8px;border:1px solid var(--line2);border-radius:999px;color:#4f5f7d;background:#f8fbff;">${esc(item)}</span><button class="btn btn-light" style="padding:4px 8px;font-size:12px;" onclick="removeCustomAnswer('${escapedQid}','${escapedItem}')">移除</button></div>`;
  }).join("");
  const customAnswerHtml = `
        <div style="margin-top:10px;border-top:1px dashed var(--line2);padding-top:10px;">
          <div style="font-size:13px;color:#5f6f8e;margin-bottom:6px;">自定义补充（可添加多条，作为 AI 选项的补充）</div>
          <div style="display:flex;gap:8px;align-items:center;">
            <input id="customInput_${q.id}" class="field" style="padding:8px 10px;" placeholder="请输入补充答案" value="" />
            <button class="btn btn-light" onclick="applyCustomAnswer('${escapedQid}')">添加</button>
          </div>
          ${customListHtml}
        </div>
      `;
  document.getElementById("questionOptions").innerHTML = optionsHtml + customAnswerHtml;
  document.getElementById("prevQuestionBtn").style.display = "inline-block";
  document.getElementById("prevQuestionBtn").disabled = params.questionIndex === 0;
  const isLast = params.questionIndex === qs.length - 1;
  document.getElementById("nextQuestionBtn").style.display = isLast ? "none" : "inline-block";
  const finishBtn = document.getElementById("finishQuestionBtn");
  if (isLast) {
    finishBtn.style.display = "inline-block";
    if (params.questionnaireFullyLoaded) {
      finishBtn.disabled = false;
      finishBtn.textContent = "完成问卷";
    } else {
      finishBtn.disabled = true;
      finishBtn.textContent = "后台补题中...";
    }
  } else {
    finishBtn.style.display = "none";
    finishBtn.disabled = false;
    finishBtn.textContent = "完成问卷";
  }

  const forceFinishBtn = document.getElementById("forceFinishBtn");
  if (!forceFinishBtn) {
    const btn = document.createElement("button");
    btn.id = "forceFinishBtn";
    btn.className = "btn btn-light";
    btn.style.color = "#d85555";
    btn.style.borderColor = "#f1c3c3";
    btn.textContent = "结束澄清并生成需求";
    btn.onclick = () => params.onForceFinish();
    document.querySelector("#questionnaireModal .modal-ft").prepend(btn);
  }
}
