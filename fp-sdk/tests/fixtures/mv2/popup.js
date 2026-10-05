chrome.storage.local.get('token', result => { document.getElementById('ready').textContent = result.token || 'ready'; });
