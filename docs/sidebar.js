/* global window, document */
(function () {
  // ─── Nav Hierarchy ──────────────────────────────────────────────
  var sections = [
    {
      title: "Getting Started",
      links: [
        { label: "Overview", href: "docs.html" },
        { label: "Record & Replay", href: "record-replay.html" },
        { label: "Quick Start: LLM", href: "chat-completions.html" },
        { label: "Quick Start: aimock", href: "aimock-cli.html" },
      ],
    },
    {
      title: "LLM Providers",
      links: [
        { label: "Chat Completions (OpenAI)", href: "chat-completions.html" },
        { label: "Responses API (OpenAI)", href: "responses-api.html" },
        { label: "Claude Messages", href: "claude-messages.html" },
        { label: "Gemini", href: "gemini.html" },
        { label: "Azure OpenAI", href: "azure-openai.html" },
        { label: "AWS Bedrock", href: "aws-bedrock.html" },
        { label: "Ollama", href: "ollama.html" },
        { label: "Cohere", href: "cohere.html" },
        { label: "Vertex AI", href: "vertex-ai.html" },
        { label: "Compatible Providers", href: "compatible-providers.html" },
      ],
    },
    {
      title: "LLM Features",
      links: [
        { label: "Embeddings", href: "embeddings.html" },
        { label: "Structured Output", href: "structured-output.html" },
        { label: "Sequential Responses", href: "sequential-responses.html" },
        { label: "Fixtures", href: "fixtures.html" },
        { label: "Error Injection", href: "error-injection.html" },
        { label: "Chaos Testing", href: "chaos-testing.html" },
        { label: "Streaming Physics", href: "streaming-physics.html" },
        { label: "WebSocket APIs", href: "websocket.html" },
        { label: "Prometheus Metrics", href: "metrics.html" },
        { label: "Mount & Composition", href: "mount.html" },
      ],
    },
    {
      title: "Additional Mocks",
      links: [
        { label: "MCPMock", href: "mcp-mock.html" },
        { label: "A2AMock", href: "a2a-mock.html" },
        { label: "VectorMock", href: "vector-mock.html" },
        { label: "Services", href: "services.html" },
      ],
    },
    {
      title: "Orchestration",
      links: [
        { label: "aimock CLI & Config", href: "aimock-cli.html" },
        { label: "Docker & Helm", href: "docker.html" },
        { label: "Drift Detection", href: "drift-detection.html" },
      ],
    },
    {
      title: "Switching to aimock",
      links: [
        { label: "From MSW", href: "migrate-from-msw.html" },
        { label: "From VidaiMock", href: "migrate-from-vidaimock.html" },
        { label: "From mock-llm", href: "migrate-from-mock-llm.html" },
        { label: "From piyook/llm-mock", href: "migrate-from-piyook.html" },
        { label: "From Python Mocks", href: "migrate-from-python-mocks.html" },
        { label: "From Mokksy", href: "migrate-from-mokksy.html" },
      ],
    },
  ];

  // ─── Section Bar Items ──────────────────────────────────────────
  var sectionBarItems = [
    { icon: "&#128225;", label: "LLM Mocking", color: "pill-green", href: "chat-completions.html" },
    { icon: "&#128268;", label: "MCP Protocol", color: "pill-blue", href: "mcp-mock.html" },
    { icon: "&#129309;", label: "A2A Protocol", color: "pill-purple", href: "a2a-mock.html" },
    { icon: "&#128230;", label: "Vector DBs", color: "pill-amber", href: "vector-mock.html" },
    { icon: "&#128269;", label: "Search &amp; Rerank", color: "pill-red", href: "services.html" },
    {
      icon: "&#9881;",
      label: "Chaos &amp; DevOps",
      color: "pill-gray",
      href: "chaos-testing.html",
    },
  ];

  // ─── Detect current page ────────────────────────────────────────
  var currentPage = window.location.pathname.split("/").pop() || "index.html";

  // ─── Build Sidebar HTML ─────────────────────────────────────────
  function buildSidebar() {
    var html = "";
    for (var i = 0; i < sections.length; i++) {
      var section = sections[i];
      html += '<div class="sidebar-section">';
      html += "<h3>" + section.title + "</h3>";
      for (var j = 0; j < section.links.length; j++) {
        var link = section.links[j];
        var activeClass = link.href === currentPage ? ' class="active"' : "";
        html += '<a href="' + link.href + '"' + activeClass + ">" + link.label + "</a>";
      }
      html += "</div>";
    }
    return html;
  }

  // ─── Build Section Bar HTML ─────────────────────────────────────
  function buildSectionBar() {
    var html = '<div class="section-bar-inner">';
    for (var i = 0; i < sectionBarItems.length; i++) {
      var item = sectionBarItems[i];
      html +=
        '<a href="' +
        item.href +
        '" class="section-pill ' +
        item.color +
        '">' +
        '<span class="section-pill-icon">' +
        item.icon +
        "</span> " +
        item.label +
        "</a>";
    }
    html += "</div>";
    return html;
  }

  // ─── Inject Section Bar CSS ─────────────────────────────────────
  var style = document.createElement("style");
  style.textContent =
    ".section-bar {" +
    "  position: sticky;" +
    "  top: 57px;" +
    "  z-index: 90;" +
    "  background: rgba(10, 10, 15, 0.85);" +
    "  backdrop-filter: blur(20px) saturate(1.4);" +
    "  -webkit-backdrop-filter: blur(20px) saturate(1.4);" +
    "  border-bottom: 1px solid var(--border);" +
    "  padding: 0.85rem 0;" +
    "  overflow-x: auto;" +
    "  -webkit-overflow-scrolling: touch;" +
    "  scrollbar-width: none;" +
    "}" +
    ".section-bar::-webkit-scrollbar { display: none; }" +
    ".section-bar-inner {" +
    "  max-width: 1400px;" +
    "  margin: 0 auto;" +
    "  padding: 0 2rem;" +
    "  display: flex;" +
    "  align-items: center;" +
    "  gap: 0.65rem;" +
    "}" +
    ".section-pill {" +
    "  display: inline-flex;" +
    "  align-items: center;" +
    "  gap: 0.4rem;" +
    "  padding: 0.5rem 0.85rem;" +
    "  background: var(--bg-card);" +
    "  border: 1px solid var(--border);" +
    "  border-radius: 4px;" +
    "  font-family: var(--font-mono);" +
    "  font-size: 0.72rem;" +
    "  font-weight: 500;" +
    "  color: var(--text-secondary);" +
    "  white-space: nowrap;" +
    "  transition: all 0.2s var(--ease-out-expo);" +
    "  text-decoration: none;" +
    "}" +
    ".section-pill:hover {" +
    "  color: var(--text-primary);" +
    "  border-color: var(--border-bright);" +
    "  background: var(--bg-card-hover);" +
    "  text-decoration: none;" +
    "  transform: translateY(-1px);" +
    "}" +
    ".section-pill.pill-green  { border-left: 3px solid var(--accent); }" +
    ".section-pill.pill-blue   { border-left: 3px solid var(--blue); }" +
    ".section-pill.pill-purple { border-left: 3px solid var(--purple); }" +
    ".section-pill.pill-amber  { border-left: 3px solid var(--warning); }" +
    ".section-pill.pill-red    { border-left: 3px solid var(--error); }" +
    ".section-pill.pill-gray   { border-left: 3px solid var(--text-dim); }" +
    ".section-pill-icon {" +
    "  font-size: 0.85rem;" +
    "  line-height: 1;" +
    "}" +
    "@media (max-width: 900px) {" +
    "  .section-bar-inner { padding: 0 1rem; }" +
    "}";
  document.head.appendChild(style);

  // ─── Inject into DOM ────────────────────────────────────────────
  var sidebarEl = document.getElementById("sidebar");
  if (sidebarEl) sidebarEl.innerHTML = buildSidebar();

  var sectionBarEl = document.getElementById("section-bar");
  if (sectionBarEl) sectionBarEl.innerHTML = buildSectionBar();
})();
