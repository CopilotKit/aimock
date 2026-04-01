/* global document, localStorage */
(function () {
  var STORAGE_KEY = "aimock-tab-preference";

  function injectStyles() {
    var style = document.createElement("style");
    style.textContent = [
      ".cli-docker-tab-bar {",
      "  display: flex;",
      "  flex-direction: row;",
      "  gap: 0;",
      "  border-bottom: 1px solid var(--border);",
      "  margin-bottom: 0;",
      "}",
      ".cli-docker-tab-bar button {",
      "  padding: 0.5rem 1.25rem;",
      "  font-family: var(--font-mono);",
      "  font-size: 0.75rem;",
      "  font-weight: 500;",
      "  background: transparent;",
      "  border: none;",
      "  border-bottom: 2px solid transparent;",
      "  color: var(--text-dim);",
      "  cursor: pointer;",
      "  transition: color 0.15s, border-color 0.15s;",
      "  outline: none;",
      "}",
      ".cli-docker-tab-bar button:hover {",
      "  color: var(--text-secondary);",
      "}",
      ".cli-docker-tab-bar button.active {",
      "  color: var(--accent);",
      "  border-bottom-color: var(--accent);",
      "  cursor: default;",
      "}",
      ".cli-docker-tabs > .tab-cli,",
      ".cli-docker-tabs > .tab-docker {",
      "  display: none;",
      "}",
      ".cli-docker-tabs > .tab-cli.active,",
      ".cli-docker-tabs > .tab-docker.active {",
      "  display: block;",
      "}",
    ].join("\n");
    document.head.appendChild(style);
  }

  function init() {
    var containers = document.querySelectorAll(".cli-docker-tabs");
    if (!containers.length) return;

    injectStyles();

    var preference = localStorage.getItem(STORAGE_KEY) || "cli";

    containers.forEach(function (container) {
      var cliLabel = container.dataset.cliLabel || "CLI";
      var dockerLabel = container.dataset.dockerLabel || "Docker";

      var tabCli = container.querySelector(".tab-cli");
      var tabDocker = container.querySelector(".tab-docker");
      if (!tabCli || !tabDocker) return;

      // Build tab bar
      var bar = document.createElement("div");
      bar.className = "cli-docker-tab-bar";

      var btnCli = document.createElement("button");
      btnCli.type = "button";
      btnCli.textContent = cliLabel;
      btnCli.dataset.tab = "cli";

      var btnDocker = document.createElement("button");
      btnDocker.type = "button";
      btnDocker.textContent = dockerLabel;
      btnDocker.dataset.tab = "docker";

      bar.appendChild(btnCli);
      bar.appendChild(btnDocker);
      container.insertBefore(bar, container.firstChild);

      // Click handlers
      btnCli.addEventListener("click", function () {
        switchAll("cli");
      });
      btnDocker.addEventListener("click", function () {
        switchAll("docker");
      });

      // Apply initial preference
      applyTab(container, preference);
    });
  }

  function applyTab(container, tab) {
    var tabCli = container.querySelector(".tab-cli");
    var tabDocker = container.querySelector(".tab-docker");
    var btnCli = container.querySelector('.cli-docker-tab-bar button[data-tab="cli"]');
    var btnDocker = container.querySelector('.cli-docker-tab-bar button[data-tab="docker"]');
    if (!tabCli || !tabDocker || !btnCli || !btnDocker) return;

    if (tab === "docker") {
      tabCli.classList.remove("active");
      tabDocker.classList.add("active");
      btnCli.classList.remove("active");
      btnDocker.classList.add("active");
    } else {
      tabCli.classList.add("active");
      tabDocker.classList.remove("active");
      btnCli.classList.add("active");
      btnDocker.classList.remove("active");
    }
  }

  function switchAll(tab) {
    localStorage.setItem(STORAGE_KEY, tab);
    var containers = document.querySelectorAll(".cli-docker-tabs");
    containers.forEach(function (container) {
      applyTab(container, tab);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
