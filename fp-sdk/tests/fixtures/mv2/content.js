document.documentElement.dataset.fpMv2 = 'injected';
chrome.runtime.sendMessage({ping:'fp-sdk-test'}, response => {
  document.documentElement.dataset.fpMv2Background = response?.pong || chrome.runtime.lastError?.message || 'no-response';
});
