export function resetDagUI() {
  const nodes = document.querySelectorAll(".dag-node");
  nodes.forEach((node) => {
    node.className = "dag-node pending";
  });
  const edges = document.querySelectorAll(".dag-edges path");
  edges.forEach((edge) => {
    edge.style.stroke = "#e5e7eb";
  });
}

export function updateDagNode(id, status) {
  const node = document.getElementById(`node-${id}`);
  if (!node) return;
  node.className = `dag-node ${status}`;
}
