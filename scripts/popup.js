document.getElementById("sendBtn").addEventListener("click", () => {
  const input = document.getElementById("searchInput").value.trim();
  if (!input) return;
  alert(`Sniffr would search for: "${input}"`);
});
