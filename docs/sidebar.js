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
        { label: "Examples", href: "/examples" },
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
      title: "Multimedia",
      links: [
        { label: "Image Generation", href: "/images" },
        { label: "Text-to-Speech", href: "/speech" },
        { label: "Audio Transcription", href: "/transcription" },
        { label: "Video Generation", href: "/video" },
      ],
    },
    {
      title: "LLM Features",
      links: [
        { label: "Embeddings", href: "/embeddings" },
        { label: "Structured Output", href: "/structured-output" },
        { label: "Sequential Responses", href: "/sequential-responses" },
        { label: "Multi-Turn Conversations", href: "/multi-turn" },
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
        { label: "AGUIMock", href: "/agui-mock" },
        { label: "VectorMock", href: "/vector-mock" },
        { label: "Services", href: "/services" },
      ],
    },
    {
      title: "Framework Guides",
      links: [
        { label: "LangChain / LangGraph", href: "/integrate-langchain" },
        { label: "CrewAI", href: "/integrate-crewai" },
        { label: "PydanticAI", href: "/integrate-pydanticai" },
        { label: "LlamaIndex", href: "/integrate-llamaindex" },
        { label: "Mastra", href: "/integrate-mastra" },
        { label: "Google ADK", href: "/integrate-adk" },
        { label: "Microsoft Agent Framework", href: "/integrate-maf" },
      ],
    },
    {
      title: "Orchestration",
      links: [
        { label: "aimock CLI & Config", href: "/aimock-cli" },
        { label: "Docker & Helm", href: "/docker" },
        { label: "GitHub Action", href: "/github-action" },
        { label: "Test Plugins", href: "/test-plugins" },
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
        { label: "From openai-responses", href: "/migrate-from-openai-responses" },
        { label: "From Mokksy", href: "/migrate-from-mokksy" },
      ],
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

  // ─── Inject into DOM ────────────────────────────────────────────
  var sidebarEl = document.getElementById("sidebar");
  if (sidebarEl) {
    sidebarEl.innerHTML = buildSidebar();
    var active = sidebarEl.querySelector(".active");
    if (active) active.scrollIntoView({ block: "center" });
  }

  // ─── Page TOC (right sidebar) ──────────────────────────────────
  function buildPageToc() {
    var tocEl = document.getElementById("page-toc");
    if (!tocEl) return;

    var content = document.querySelector(".docs-content");
    if (!content) return;

    var headings = content.querySelectorAll("h2, h3");

    // Always assign ids so cross-page anchors resolve, even on short pages.
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

    // TOC rendering requires at least 4 headings to be worth the space.
    if (headings.length < 4) return;

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
