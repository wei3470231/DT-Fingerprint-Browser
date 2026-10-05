'use strict';
const shell = window.browserShell;
const $ = selector => document.querySelector(selector);
const editor = $('#editor');
let state = null, optionsReady = false;
let editing = { profileId: null, dirty: false, color: null };

function call(channel, payload) {
  return shell.call(channel, payload).catch(error => {
    toast(String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    throw error;
  });
}
let toastTimer = null;
function toast(message, isError = false) {
  const box = $('#toast');
  box.textContent = message;
  box.className = isError ? 'show error' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.className = ''; }, isError ? 5000 : 2600);
}
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) if (child != null) node.append(child);
  return node;
};
const activeTab = () => state?.tabs.find(tab => tab.id === state.activeId) || null;
const profileOf = id => state?.profiles.find(profile => profile.id === id) || null;

// ---------- 下拉选项（只需填充一次） ----------
function fillOptions(options, colors) {
  const fillSelect = (name, items) => {
    editor.elements[name].replaceChildren(...items.map(item => el('option', { value: item.value, textContent: item.label })));
  };
  fillSelect('os', options.os);
  fillSelect('language', options.languages);
  fillSelect('cores', options.cores.map(value => ({ value, label: `${value}` })));
  fillSelect('memory', options.memory.map(value => ({ value, label: `${value}` })));
  fillSelect('dpr', options.dpr.map(value => ({ value, label: `${value}` })));
  $('#timezones').replaceChildren(...options.timezones.map(value => el('option', { value })));
  $('#screens').replaceChildren(...options.screens.map(value => el('option', { value })));
  $('#gpu-vendors').replaceChildren(...[...new Set(options.gpus.map(g => g.vendor))].map(value => el('option', { value })));
  $('#gpu-preset').replaceChildren(el('option', { value: '', textContent: '选择预设显卡…' }),
    ...options.gpus.map((gpu, index) => el('option', { value: String(index), textContent: gpu.renderer.replace(/^ANGLE \([^,]+, /, '').replace(/ Direct3D.*$/, '') })));
  $('#gpu-preset').onchange = event => {
    const gpu = options.gpus[Number(event.target.value)];
    if (gpu) { editor.elements.gpuVendor.value = gpu.vendor; editor.elements.gpuRenderer.value = gpu.renderer; markDirty(); }
    event.target.value = '';
  };
  $('#colors').replaceChildren(...colors.map(color => el('button', { type: 'button', className: 'swatch', title: color, onclick: () => { editing.color = color; markDirty(); renderColors(); } })));
  [...$('#colors').children].forEach((button, index) => button.style.setProperty('--c', colors[index]));
  optionsReady = true;
}
function renderColors() {
  for (const button of $('#colors').children) button.classList.toggle('selected', button.title === editing.color);
}

// ---------- 渲染 ----------
function render() {
  if (!state) return;
  if (!optionsReady) fillOptions(state.options, state.colors);
  document.documentElement.style.setProperty('--chrome-height', `${state.layout.chromeHeight}px`);
  document.documentElement.style.setProperty('--drawer-width', `${state.layout.drawerWidth}px`);
  renderTabs();
  renderToolbar();
  renderDrawer();
}

function renderTabs() {
  const nodes = state.tabs.map(tab => {
    const profile = profileOf(tab.profileId);
    const icon = tab.loading ? el('span', { className: 'spinner' })
      : tab.favicon ? el('img', { className: 'favicon', src: tab.favicon, alt: '', onerror: e => e.target.replaceWith(el('span', { className: 'favicon blank' })) })
        : el('span', { className: 'favicon blank' });
    const node = el('div', {
      className: `tab${tab.id === state.activeId ? ' active' : ''}${tab.error ? ' failed' : ''}`,
      title: `${tab.title}\n${profile?.name ?? ''} · ${tab.url}`, role: 'tab',
    }, [
      icon,
      el('span', { className: 'title', textContent: tab.title }),
      el('button', { className: 'close', title: '关闭（Ctrl+W）', innerHTML: '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>' }),
    ]);
    node.dataset.id = tab.id;
    node.style.setProperty('--c', profile?.color || '#888');
    return node;
  });
  $('#tabs').replaceChildren(...nodes);
  $('#tabs').querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderToolbar() {
  const tab = activeTab(), profile = tab && profileOf(tab.profileId);
  $('#back').disabled = !tab?.canGoBack;
  $('#forward').disabled = !tab?.canGoForward;
  $('#reload').classList.toggle('loading', !!tab?.loading);
  $('#reload').title = tab?.loading ? '停止' : '重新加载（F5）';
  const address = $('#address');
  if (document.activeElement !== address) address.value = tab ? (tab.url === 'fpb://newtab' ? '' : tab.url) : '';
  const chip = $('#identity');
  chip.style.setProperty('--c', profile?.color || '#888');
  chip.querySelector('.name').textContent = profile?.name || '—';
  chip.title = profile ? `${profile.name}\n${profile.summary}\n点击查看或编辑指纹` : '';
  $('#toggle-drawer').classList.toggle('on', state.drawer.open);
  $('#page-status').textContent = tab?.error || (tab?.loading ? '正在加载…' : '');
  $('#page-status').classList.toggle('error', !!tab?.error);
}

function renderDrawer() {
  const drawer = $('#drawer');
  drawer.hidden = !state.drawer.open;
  if (!state.drawer.open) return;
  $('#profile-list').replaceChildren(...state.profiles.map(profile => {
    const card = el('button', { type: 'button', className: `profile-card${profile.id === state.drawer.profileId ? ' selected' : ''}` }, [
      el('span', { className: 'dot' }),
      el('span', { className: 'meta' }, [
        el('strong', { textContent: profile.name }),
        el('small', { textContent: profile.summary }),
      ]),
      el('span', { className: 'count', textContent: `${profile.tabCount} 个标签`, title: '打开的标签页数量' }),
    ]);
    card.style.setProperty('--c', profile.color);
    card.onclick = () => selectProfile(profile.id);
    return card;
  }));
  const profile = profileOf(state.drawer.profileId);
  editor.hidden = !profile;
  if (profile && (profile.id !== editing.profileId || !editing.dirty)) loadEditor(profile);
  $('#editor-hint').textContent = profile?.tabCount
    ? `保存后，此身份的 ${profile.tabCount} 个标签页会重启以应用新指纹；Cookie 与登录状态保留。`
    : '保存后，新打开的标签页使用新指纹。';
  $('#delete-profile').disabled = state.profiles.length < 2;
  const v = state.versions;
  $('#versions').textContent = `Electron ${v.electron} · Chromium ${v.chrome}${v.fpkernel ? ` · FP Kernel ${v.fpkernel}` : ''}`;
}

function loadEditor(profile) {
  editing = { profileId: profile.id, dirty: false, color: profile.color };
  const f = editor.elements;
  f.name.value = profile.name;
  f.proxy.value = profile.proxy;
  setForm(profile.form);
  renderColors();
  editor.querySelector('h3').textContent = `编辑「${profile.name}」`;
}
function setForm(form) {
  const f = editor.elements;
  for (const key of ['seed', 'os', 'language', 'timezone', 'cores', 'memory', 'screen', 'dpr', 'gpuVendor', 'gpuRenderer']) f[key].value = String(form[key]);
  for (const key of ['canvas', 'audio', 'rects']) f[key].checked = !!form[key];
}
function readForm() {
  const f = editor.elements;
  const form = {};
  for (const key of ['seed', 'os', 'language', 'timezone', 'screen', 'gpuVendor', 'gpuRenderer']) form[key] = f[key].value.trim();
  for (const key of ['cores', 'memory', 'dpr']) form[key] = Number(f[key].value);
  for (const key of ['canvas', 'audio', 'rects']) form[key] = f[key].checked;
  return { id: editing.profileId, name: f.name.value, color: editing.color, proxy: f.proxy.value, form };
}
function markDirty() { editing.dirty = true; }

function selectProfile(profileId) {
  if (editing.dirty && editing.profileId !== profileId && !confirm('当前身份有未保存的修改，放弃修改？')) return;
  editing.dirty = false;
  call('drawer', { open: true, profileId }).catch(() => {});
}

// ---------- 事件 ----------
$('#tabs').addEventListener('click', event => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  const id = Number(tab.dataset.id);
  if (event.target.closest('.close')) call('tab:close', { id }).catch(() => {});
  else call('tab:activate', { id }).catch(() => {});
});
$('#tabs').addEventListener('auxclick', event => {
  const tab = event.target.closest('.tab');
  if (tab && event.button === 1) call('tab:close', { id: Number(tab.dataset.id) }).catch(() => {});
});
$('#tabs').addEventListener('contextmenu', event => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  event.preventDefault();
  call('tab:menu', { id: Number(tab.dataset.id), x: event.clientX, y: event.clientY }).catch(() => {});
});
$('#tabs').addEventListener('wheel', event => { $('#tabs').scrollLeft += event.deltaY; }, { passive: true });
$('#new-tab').onclick = () => call('tab:new', {}).catch(() => {});
$('#new-tab-menu').onclick = event => {
  const box = event.currentTarget.getBoundingClientRect();
  call('tab:new-menu', { x: box.left, y: box.bottom }).catch(() => {});
};
$('#back').onclick = () => call('tab:action', { id: state.activeId, action: 'back' }).catch(() => {});
$('#forward').onclick = () => call('tab:action', { id: state.activeId, action: 'forward' }).catch(() => {});
$('#reload').onclick = () => call('tab:action', { id: state.activeId, action: activeTab()?.loading ? 'stop' : 'reload' }).catch(() => {});
$('#address-form').onsubmit = event => {
  event.preventDefault();
  const input = $('#address');
  call('tab:navigate', { id: state.activeId, input: input.value }).then(() => input.blur(), () => {});
};
$('#address').addEventListener('focus', event => event.target.select());
$('#address').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.target.blur(); renderToolbar(); }
});
$('#identity').onclick = () => {
  const tab = activeTab();
  call('drawer', { open: !(state.drawer.open && state.drawer.profileId === tab?.profileId), profileId: tab?.profileId }).catch(() => {});
};
$('#toggle-drawer').onclick = () => call('drawer', { open: !state.drawer.open, profileId: state.drawer.profileId || activeTab()?.profileId }).catch(() => {});
$('#close-drawer').onclick = () => call('drawer', { open: false, profileId: state.drawer.profileId }).catch(() => {});
$('#create-profile').onclick = () => {
  if (editing.dirty && !confirm('当前身份有未保存的修改，放弃修改？')) return;
  editing.dirty = false;
  call('profile:create').then(() => toast('已新建身份，并在其中打开新标签页'), () => {});
};

editor.addEventListener('input', markDirty);
editor.addEventListener('change', markDirty);
editor.onsubmit = event => {
  event.preventDefault();
  const button = editor.querySelector('.primary');
  button.disabled = true;
  call('profile:save', readForm()).then(({ restarted }) => {
    editing.dirty = false;
    loadEditor(profileOf(editing.profileId));
    toast(restarted ? `已保存，${restarted} 个标签页已用新指纹重启` : '已保存');
  }, () => {}).finally(() => { button.disabled = false; });
};
$('#randomize').onclick = () => {
  const f = editor.elements;
  call('profile:random', { language: f.language.value, timezone: f.timezone.value }).then(form => {
    setForm(form);
    markDirty();
    toast('已生成随机指纹，点击“保存并应用”生效');
  }, () => {});
};
$('#open-in-profile').onclick = () => call('tab:new', { profileId: editing.profileId }).catch(() => {});
$('#delete-profile').onclick = () => {
  const profile = profileOf(editing.profileId);
  if (!profile || !confirm(`删除「${profile.name}」？\n将关闭它的 ${profile.tabCount} 个标签页，并清除该身份的 Cookie、缓存和网站存储。此操作不可撤销。`)) return;
  editing.dirty = false;
  call('profile:delete', { id: profile.id }).then(() => toast(`已删除「${profile.name}」`), () => {});
};

shell.on('state', next => { state = next; render(); });
shell.on('toast', message => toast(message, true));
shell.on('focus-address', () => { $('#address').focus(); $('#address').select(); });
call('state').then(next => { state = next; render(); }, () => {});
