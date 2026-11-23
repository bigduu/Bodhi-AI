(() => {
  let locale = "en-US";
  let messages;
  let pending = Promise.resolve();
  const mirrors = { "gh-proxy": "gh-proxy.com", "gh-fast": "ghfast.top" };

  function text(key, values = {}) {
    return (messages?.[key] || key).replace(/\{([A-Za-z]+)\}/g, (match, name) =>
      Object.hasOwn(values, name) ? values[name] : match,
    );
  }

  function sync(expectedLocale) {
    pending = pending.then(() => refresh(expectedLocale));
    return pending;
  }

  async function refresh(expectedLocale) {
    if ((messages && (!expectedLocale || expectedLocale === locale)) || !window.__TAURI_INTERNALS__) return;
    try {
      ({ locale, messages } = await window.__TAURI_INTERNALS__.invoke("shell_translations"));
    } catch (error) {
      console.warn("Bodhi translations are unavailable", error);
      return;
    }
    document.documentElement.lang = locale;
    for (const node of document.querySelectorAll("[data-i18n]")) {
      node.textContent = text(node.dataset.i18n);
    }
    for (const node of document.querySelectorAll("[data-i18n-label]")) {
      node.setAttribute("aria-label", text(node.dataset.i18nLabel));
    }
  }

  function bytes(size) {
    if (size < 1024) return size.toLocaleString(locale) + " B";
    const [divisor, unit] = size < 1024 ** 2 ? [1024, "KiB"] : [1024 ** 2, "MiB"];
    return (size / divisor).toLocaleString(locale, { maximumFractionDigits: 1 }) + " " + unit;
  }

  function transferText({ file, source, received, total }) {
    let counter = bytes(received);
    if (total > 0) {
      const percent = (Math.floor(100 * received / total) / 100).toLocaleString(locale, { style: "percent" });
      counter += " / " + bytes(total) + " · " + percent;
    }
    const sourceName = source === "github" ? text("source.github") : mirrors[source] || "npm";
    return file + " · " + sourceName + " · " + counter;
  }

  window.bodhiI18n = { text, sync, transferText, date: (value) => new Date(value).toLocaleString(locale) };
})();
