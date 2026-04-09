/* global window, document, IntersectionObserver, history */
(function () {
  // ─── Nav Hierarchy ──────────────────────────────────────────────
  var sections = [
    {
      title: "Getting Started",
      links: [
        { label: "Overview", href: "/docs" },
        { label: "Record & Replay", href: "/record-replay" },
        { label: "Quick Start: LLM", href: "/chat-completions" },
        { label: "Quick Start: aimock", href: "/aimock-cli" },
      ],
    },
    {
      title: "LLM Providers",
      links: [
        { label: "Chat Completions (OpenAI)", href: "/chat-completions" },
        { label: "Responses API (OpenAI)", href: "/responses-api" },
        { label: "Claude Messages", href: "/claude-messages" },
        { label: "Gemini", href: "/gemini" },
        { label: "Azure OpenAI", href: "/azure-openai" },
        { label: "AWS Bedrock", href: "/aws-bedrock" },
        { label: "Ollama", href: "/ollama" },
        { label: "Cohere", href: "/cohere" },
        { label: "Vertex AI", href: "/vertex-ai" },
        { label: "Compatible Providers", href: "/compatible-providers" },
      ],
    },
    {
      title: "LLM Features",
      links: [
        { label: "Embeddings", href: "/embeddings" },
        { label: "Structured Output", href: "/structured-output" },
        { label: "Sequential Responses", href: "/sequential-responses" },
        { label: "Fixtures", href: "/fixtures" },
        { label: "Error Injection", href: "/error-injection" },
        { label: "Chaos Testing", href: "/chaos-testing" },
        { label: "Streaming Physics", href: "/streaming-physics" },
        { label: "WebSocket APIs", href: "/websocket" },
        { label: "Prometheus Metrics", href: "/metrics" },
        { label: "Mount & Composition", href: "/mount" },
      ],
    },
    {
      title: "Additional Mocks",
      links: [
        { label: "MCPMock", href: "/mcp-mock" },
        { label: "A2AMock", href: "/a2a-mock" },
        { label: "VectorMock", href: "/vector-mock" },
        { label: "Services", href: "/services" },
      ],
    },
    {
      title: "Orchestration",
      links: [
        { label: "aimock CLI & Config", href: "/aimock-cli" },
        { label: "Docker & Helm", href: "/docker" },
        { label: "Drift Detection", href: "/drift-detection" },
      ],
    },
    {
      title: "Switching to aimock",
      links: [
        { label: "From MSW", href: "/migrate-from-msw" },
        { label: "From VidaiMock", href: "/migrate-from-vidaimock" },
        { label: "From mock-llm", href: "/migrate-from-mock-llm" },
        { label: "From piyook/llm-mock", href: "/migrate-from-piyook" },
        { label: "From Python Mocks", href: "/migrate-from-python-mocks" },
        { label: "From Mokksy", href: "/migrate-from-mokksy" },
      ],
    },
  ];

  // ─── Section Bar Items ──────────────────────────────────────────
  var sectionBarItems = [
    { icon: "&#128225;", label: "LLM Mocking", color: "pill-green", href: "/chat-completions" },
    { icon: "&#128268;", label: "MCP Protocol", color: "pill-blue", href: "/mcp-mock" },
    { icon: "&#129309;", label: "A2A Protocol", color: "pill-purple", href: "/a2a-mock" },
    { icon: "&#128230;", label: "Vector DBs", color: "pill-amber", href: "/vector-mock" },
    { icon: "&#128269;", label: "Search &amp; Rerank", color: "pill-red", href: "/services" },
    {
      icon: "&#9881;",
      label: "Chaos &amp; DevOps",
      color: "pill-gray",
      href: "/chaos-testing",
    },
  ];

  // ─── Detect current page ────────────────────────────────────────
  var p = window.location.pathname.replace(/\/index\.html$/, "").replace(/\/$/, "");
  var currentPage = p || "/";

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
  if (sidebarEl) {
    sidebarEl.innerHTML = buildSidebar();
    var active = sidebarEl.querySelector(".active");
    if (active) active.scrollIntoView({ block: "center" });
  }

  // Only inject section bar on the overview page (/docs) — inner pages should not show it
  var isOverview = currentPage === "/docs";
  var sectionBarEl = document.getElementById("section-bar");
  if (sectionBarEl && isOverview) sectionBarEl.innerHTML = buildSectionBar();

  // ─── Page TOC (right sidebar) ──────────────────────────────────
  function buildPageToc() {
    var tocEl = document.getElementById("page-toc");
    if (!tocEl) return;

    var content = document.querySelector(".docs-content");
    if (!content) return;

    var headings = content.querySelectorAll("h2, h3");
    if (headings.length < 4) return;

    // Ensure each heading has an id for anchor links
    for (var i = 0; i < headings.length; i++) {
      var h = headings[i];
      if (!h.id) {
        h.id = h.textContent
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "");
      }
    }

    // Build TOC HTML
    var html = '<div class="page-toc-label">On this page</div>';
    for (var j = 0; j < headings.length; j++) {
      var heading = headings[j];
      var cls = heading.tagName === "H3" ? ' class="toc-h3"' : "";
      html += '<a href="#' + heading.id + '"' + cls + ">" + heading.textContent + "</a>";
    }
    tocEl.innerHTML = html;

    // Active state tracking with IntersectionObserver
    var tocLinks = tocEl.querySelectorAll('a[href^="#"]');
    var headingEls = [];
    for (var k = 0; k < tocLinks.length; k++) {
      var target = document.getElementById(tocLinks[k].getAttribute("href").slice(1));
      if (target) headingEls.push(target);
    }

    if (!headingEls.length || typeof IntersectionObserver === "undefined") return;

    function setActive(index) {
      for (var m = 0; m < tocLinks.length; m++) {
        tocLinks[m].classList.remove("active");
      }
      if (tocLinks[index]) {
        tocLinks[index].classList.add("active");
      }
    }

    var observer = new IntersectionObserver(
      function (entries) {
        // Find the topmost visible heading
        var topmostIndex = -1;
        for (var n = 0; n < entries.length; n++) {
          if (entries[n].isIntersecting) {
            var idx = headingEls.indexOf(entries[n].target);
            if (idx !== -1 && (topmostIndex === -1 || idx < topmostIndex)) {
              topmostIndex = idx;
            }
          }
        }
        if (topmostIndex !== -1) {
          setActive(topmostIndex);
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0 },
    );

    for (var p = 0; p < headingEls.length; p++) {
      observer.observe(headingEls[p]);
    }

    // Set initial active state
    setActive(0);

    // Smooth scroll on click
    for (var q = 0; q < tocLinks.length; q++) {
      tocLinks[q].addEventListener("click", function (e) {
        e.preventDefault();
        var targetEl = document.getElementById(this.getAttribute("href").slice(1));
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
          // Update URL hash without jumping
          history.pushState(null, "", this.getAttribute("href"));
        }
      });
    }
  }

  buildPageToc();
})();
