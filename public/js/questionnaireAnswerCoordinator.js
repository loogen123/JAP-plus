export function createQuestionnaireAnswerCoordinator(ctx) {
  const { runtime, finalizeFlow, renderCurrentQuestion } = ctx;

  function setModalAnswer(qid, opt) {
    runtime.answers[qid] = opt;
    finalizeFlow.scheduleBackgroundFinalize("single");
  }

  function toggleModalAnswer(qid, opt, checked) {
    if (!Array.isArray(runtime.answers[qid])) runtime.answers[qid] = [];
    const next = new Set(runtime.answers[qid]);
    if (checked) next.add(opt);
    else next.delete(opt);
    runtime.answers[qid] = Array.from(next);
    finalizeFlow.scheduleBackgroundFinalize("multiple");
  }

  function applyCustomAnswer(qid) {
    const input = document.getElementById(`customInput_${qid}`);
    const value = (input?.value || "").trim();
    if (!value) return;
    if (!runtime.customAnswers[qid]) runtime.customAnswers[qid] = [];
    if (!runtime.customAnswers[qid].includes(value)) runtime.customAnswers[qid].push(value);
    input.value = "";
    finalizeFlow.scheduleBackgroundFinalize("custom-add");
    renderCurrentQuestion();
  }

  function removeCustomAnswer(qid, value) {
    if (!runtime.customAnswers[qid]) return;
    runtime.customAnswers[qid] = runtime.customAnswers[qid].filter((item) => item !== value);
    finalizeFlow.scheduleBackgroundFinalize("custom-remove");
    renderCurrentQuestion();
  }

  function prevQuestion() {
    if (runtime.questionIndex > 0) {
      runtime.questionIndex -= 1;
      renderCurrentQuestion();
    }
  }

  function nextQuestion() {
    const qs = runtime.activeQuestionnaire || [];
    if (runtime.questionIndex < qs.length - 1) {
      runtime.questionIndex += 1;
      renderCurrentQuestion();
    }
  }

  return {
    setModalAnswer,
    toggleModalAnswer,
    applyCustomAnswer,
    removeCustomAnswer,
    prevQuestion,
    nextQuestion,
  };
}
