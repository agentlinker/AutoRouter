const tokenInput = document.querySelector("#admin-token");
const saveTokenButton = document.querySelector("#save-token");
const authStatus = document.querySelector("#auth-status");
const authView = document.querySelector("#auth-view");
const providerManagement = document.querySelector("#provider-management");
const providerForm = document.querySelector("#provider-form");
const providerFormTitle = document.querySelector("#provider-form-title");
const providerFormHelp = document.querySelector("#provider-form-help");
const submitProviderButton = document.querySelector("#submit-provider");
const cancelEditButton = document.querySelector("#cancel-edit");
const apiKeyLabel = document.querySelector("#api-key-label");
const formStatus = document.querySelector("#form-status");
const providersContainer = document.querySelector("#providers");
const providerSummary = document.querySelector("#provider-summary");
const refreshProvidersButton = document.querySelector("#refresh-providers");
const lockConsoleButton = document.querySelector("#lock-console");

let currentProviders = [];
let editingProvider = null;

tokenInput.value = localStorage.getItem("autorouter_admin_token") ?? "";

function hasAdminToken() {
  return tokenInput.value.trim().length > 0;
}

function setStatus(element, message, mode = "") {
  element.textContent = message;
  element.classList.remove("error", "success");
  if (mode) {
    element.classList.add(mode);
  }
}

function setAuthenticated(authenticated) {
  authView.hidden = authenticated;
  providerManagement.hidden = !authenticated;
}

function adminHeaders() {
  const token = tokenInput.value.trim();
  return {
    "content-type": "application/json",
    authorization: token ? `Bearer ${token}` : ""
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...adminHeaders(),
      ...(options.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function renderProviderSummary(items) {
  const modelCount = items.reduce((sum, item) => sum + item.models.length, 0);
  providerSummary.textContent = `${items.length} providers · ${modelCount} models`;
}

function renderProviders(items) {
  currentProviders = items;
  providersContainer.innerHTML = "";
  renderProviderSummary(items);

  if (items.length === 0) {
    providersContainer.innerHTML = `
      <div class="empty-state">
        <div>
          <strong>暂无 Provider</strong>
          <p>新增一个 provider 后，模型会自动同步到 SQLite。</p>
        </div>
      </div>
    `;
    return;
  }

  for (const item of items) {
    const container = document.createElement("article");
    container.className = "provider-item";

    const models = item.models
      .slice(0, 16)
      .map((model) => `<li>${model.model_name}</li>`)
      .join("");
    const hiddenModelCount = Math.max(0, item.models.length - 16);

    container.innerHTML = `
      <div class="provider-row">
        <div class="provider-title">
          <strong>${item.display_name}</strong>
          <code>${item.provider_key}</code>
        </div>
        <span class="badge ${item.enabled ? "success" : "warning"}">
          ${item.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      <div class="provider-meta">
        <div class="metric">
          <span>官网</span>
          ${
            item.website_url
              ? `<a href="${item.website_url}" target="_blank" rel="noreferrer">${item.website_url}</a>`
              : "<strong>未填写</strong>"
          }
        </div>
        <div class="metric">
          <span>Base URL</span>
          <code>${item.base_url}</code>
        </div>
        <div class="metric">
          <span>Models</span>
          <strong>${item.models.length}</strong>
        </div>
        <div class="metric">
          <span>Key</span>
          <strong>${item.key_hint ?? "hidden"}</strong>
        </div>
      </div>

      <div class="provider-actions">
        <button data-action="edit" data-provider="${item.provider_key}">编辑</button>
        <button data-action="sync" data-provider="${item.provider_key}">同步模型</button>
        <button data-action="toggle" data-provider="${item.provider_key}" data-enabled="${item.enabled}">
          ${item.enabled ? "禁用" : "启用"}
        </button>
        <button data-action="delete" data-provider="${item.provider_key}">删除</button>
      </div>

      <ul class="model-list">
        ${models}
        ${hiddenModelCount > 0 ? `<li>+${hiddenModelCount}</li>` : ""}
      </ul>
    `;

    providersContainer.appendChild(container);
  }
}

async function loadProviders() {
  const data = await requestJson("/admin/api/providers");
  renderProviders(data.data ?? []);
}

function setFormMode(provider = null) {
  editingProvider = provider;
  providerForm.reset();
  setStatus(formStatus, "", "");

  const providerKeyInput = providerForm.elements.namedItem("provider_key");
  const displayNameInput = providerForm.elements.namedItem("display_name");
  const baseUrlInput = providerForm.elements.namedItem("base_url");
  const websiteUrlInput = providerForm.elements.namedItem("website_url");
  const apiKeyInput = providerForm.elements.namedItem("api_key");

  if (!provider) {
    providerFormTitle.textContent = "新增 Provider";
    providerFormHelp.textContent = "填写服务信息后，系统会自动找到可用模型并保存起来。";
    submitProviderButton.textContent = "保存并同步";
    cancelEditButton.hidden = true;
    apiKeyLabel.classList.add("required-label");
    providerKeyInput.readOnly = false;
    apiKeyInput.required = true;
    apiKeyInput.placeholder = "sk-...";
    return;
  }

  providerFormTitle.textContent = "编辑 Provider";
  providerFormHelp.textContent = "修改名称或官网会直接保存；修改 Base URL 时会重新检查可用模型。";
  submitProviderButton.textContent = "保存修改";
  cancelEditButton.hidden = false;
  apiKeyLabel.classList.remove("required-label");
  providerKeyInput.readOnly = true;
  providerKeyInput.value = provider.provider_key;
  displayNameInput.value = provider.display_name;
  baseUrlInput.value = provider.base_url;
  websiteUrlInput.value = provider.website_url ?? "";
  apiKeyInput.required = false;
  apiKeyInput.value = "";
  apiKeyInput.placeholder = "不修改可留空";
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function validateProviderForm(body) {
  const required = [
    ["provider_key", "请填写 Provider Key"],
    ["display_name", "请填写 Display Name"],
    ["base_url", "请填写 Base URL"]
  ];

  if (!editingProvider) {
    required.push(["api_key", "请填写 API Key"]);
  }

  for (const [field, message] of required) {
    if (!String(body[field] ?? "").trim()) {
      return message;
    }
  }

  if (!isValidUrl(body.base_url)) {
    return "Base URL 必须是有效的网址";
  }

  if (body.website_url && !isValidUrl(body.website_url)) {
    return "官网地址必须是有效的网址";
  }

  return null;
}

async function authenticateAndLoad() {
  if (!hasAdminToken()) {
    setAuthenticated(false);
    setStatus(authStatus, "请输入 Admin Token", "error");
    return;
  }

  localStorage.setItem("autorouter_admin_token", tokenInput.value);
  setStatus(authStatus, "正在验证...", "");

  try {
    await loadProviders();
    setAuthenticated(true);
    setStatus(authStatus, "验证通过", "success");
  } catch (error) {
    setAuthenticated(false);
    setStatus(authStatus, error instanceof Error ? error.message : "验证失败", "error");
  }
}

saveTokenButton.addEventListener("click", authenticateAndLoad);

tokenInput.addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    await authenticateAndLoad();
  }
});

refreshProvidersButton.addEventListener("click", async () => {
  providerSummary.textContent = "正在刷新";
  await loadProviders();
});

lockConsoleButton.addEventListener("click", () => {
  localStorage.removeItem("autorouter_admin_token");
  tokenInput.value = "";
  providerSummary.textContent = "未登录";
  providersContainer.innerHTML = "";
  setStatus(authStatus, "已锁定", "");
  setAuthenticated(false);
});

providerForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(providerForm);
  const body = Object.fromEntries(formData.entries());
  const validationError = validateProviderForm(body);
  if (validationError) {
    setStatus(formStatus, validationError, "error");
    return;
  }

  const baseUrlChanged = editingProvider && body.base_url !== editingProvider.base_url;
  setStatus(
    formStatus,
    baseUrlChanged ? "正在保存并重新检查可用模型..." : "正在保存...",
    ""
  );

  try {
    if (editingProvider) {
      const payload = {
        display_name: body.display_name,
        base_url: body.base_url,
        website_url: body.website_url
      };

      if (body.api_key) {
        payload.api_key = body.api_key;
      }

      await requestJson(`/admin/api/providers/${editingProvider.provider_key}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      setStatus(
        formStatus,
        baseUrlChanged ? "Provider 已保存，可用模型已更新" : "Provider 已保存",
        "success"
      );
    } else {
      await requestJson("/admin/api/providers", {
        method: "POST",
        body: JSON.stringify(body)
      });
      setStatus(formStatus, "Provider 已保存并完成模型检查", "success");
    }

    setFormMode(null);
    await loadProviders();
  } catch (error) {
    setStatus(formStatus, error instanceof Error ? error.message : "保存失败", "error");
  }
});

cancelEditButton.addEventListener("click", () => {
  setFormMode(null);
});

providersContainer.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }

  const providerKey = target.dataset.provider;
  const action = target.dataset.action;
  if (!providerKey || !action) {
    return;
  }

  target.disabled = true;

  try {
    if (action === "edit") {
      const provider = currentProviders.find((item) => item.provider_key === providerKey);
      if (provider) {
        setFormMode(provider);
        providerForm.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    if (action === "sync") {
      await requestJson(`/admin/api/providers/${providerKey}/sync-models`, { method: "POST" });
    }

    if (action === "toggle") {
      const enabled = target.dataset.enabled !== "true";
      await requestJson(`/admin/api/providers/${providerKey}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled })
      });
    }

    if (action === "delete") {
      await requestJson(`/admin/api/providers/${providerKey}`, { method: "DELETE" });
    }

    await loadProviders();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "操作失败");
  } finally {
    target.disabled = false;
  }
});

if (hasAdminToken()) {
  authenticateAndLoad();
} else {
  setAuthenticated(false);
}
