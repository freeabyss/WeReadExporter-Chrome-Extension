'use strict';

(function () {
  const versionEl = document.getElementById('version');
  if (versionEl && chrome.runtime && chrome.runtime.getManifest) {
    versionEl.textContent = chrome.runtime.getManifest().version;
  }

  document.getElementById('open-reader').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://weread.qq.com/web/shelf' });
    window.close();
  });

  document.getElementById('reload').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.id) return;
      chrome.tabs.reload(tab.id);
      window.close();
    });
  });
})();
