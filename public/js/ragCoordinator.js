(function initRagCoordinator() {
  window.openRagPanel = function openRagPanel() {
    if (window.RAG_PANEL && typeof window.RAG_PANEL.open === "function") {
      void window.RAG_PANEL.open();
    }
  };
})();
