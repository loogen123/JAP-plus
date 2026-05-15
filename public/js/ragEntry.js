(function initRagEntry() {
  let loading = null;
  window.openRagModal = async function openRagModal() {
    if (!window.RAG_MODAL || typeof window.RAG_MODAL.open !== "function") {
      if (!loading) {
        loading = new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "/js/ragModal.js";
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("failed to load ragModal.js"));
          document.head.appendChild(script);
        });
      }
      await loading;
    }
    if (window.RAG_MODAL && typeof window.RAG_MODAL.open === "function") {
      await window.RAG_MODAL.open();
    }
  };
})();
