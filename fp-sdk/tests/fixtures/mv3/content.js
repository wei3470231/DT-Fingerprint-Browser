document.documentElement.dataset.fpMv3 = 'injected';
chrome.runtime.sendMessage({ping:'fp-sdk-test'}, response => {
  document.documentElement.dataset.fpMv3Background = response?.pong || chrome.runtime.lastError?.message || 'no-response';
});
