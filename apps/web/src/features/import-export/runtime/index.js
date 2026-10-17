/* global fetch, document, setTimeout, location, FormData, AbortController, File */

const API = '/api/backups/archive';
const TT_API = '/api/backups/tauritavern';
const state = {
  inspection: null,
  selectedFile: null,
  preview: null,
  ttFile: null,
  ttPreview: null,
  importAbort: null,
  ttImportAbort: null,
};
const syncState = {
  // null = 未解锁。解锁后是 { baseUrl, username, accountId }，只存在内存里。
  unlocked: null,
  snapshots: [],
};
const IMPORT_METHODS = Object.freeze([
  { value: 'fast', label: '快速导入（高内存占用）' },
  { value: 'slow', label: '慢速导入（低内存占用）' },
]);
const IMPORT_STRATEGIES = Object.freeze([
  { value: 'merge', label: '合并并覆盖冲突' },
  { value: 'skip', label: '跳过冲突' },
  { value: 'replace-module', label: '替换选中模块' },
  { value: 'replace-all', label: '替换归档模块' },
  { value: 'replace-local', label: '完全替换本地（含 Secrets）' },
]);

function headers() {
  return { 'Content-Type': 'application/json' };
}

async function postJson(path, body = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
    cache: 'no-cache',
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : { ok: true };
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: HTTP ${response.status}`);
  }
  return payload;
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = bytes / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[index]}`;
}

function streamingUiOptions(controller, target, label) {
  return {
    signal: controller?.signal,
    onProgress(progress) {
      const path = progress.path ? `\n${progress.path}` : '';
      const total = Number(progress.total) || 0;
      const percent = total ? ` ${Math.min(100, (progress.loaded / total) * 100).toFixed(1)}%` : '';
      target.textContent = `${label}中${percent}${path}`;
    },
  };
}

function importExecutionOptions(method, controller, target, label) {
  return { method, ...streamingUiOptions(controller, target, label) };
}

function formatExactImportPreview(preview, strategy, format, method) {
  return [
    `${format} 精确预览`,
    `导入方式：${importMethodLabel(method)}`,
    `导入模式：${strategyLabel(strategy)}`,
    completeLocalReplacementWarning(strategy),
    `所选内容：${formatBytes(preview.totalBytes)}`,
    ...(preview.modules ?? [])
      .filter((module) => module.selected)
      .map(
        (module) =>
          `${module.displayName}: ${module.incomingRecords} records · ${module.incomingBlobs} blobs · ${module.conflicts} conflicts`,
      ),
  ]
    .filter(Boolean)
    .join('\n');
}

function selectedModules() {
  return [...document.querySelectorAll('#ptdm-modules input[data-module]:checked')].map(
    (input) => input.dataset.module,
  );
}

function importMethodOptions() {
  return IMPORT_METHODS.map(
    (method) => `<option value="${method.value}">${method.label}</option>`,
  ).join('');
}

function selectedImportMethod() {
  const selected = document.querySelector('#ptdm-import-method')?.value;
  return IMPORT_METHODS.some((method) => method.value === selected) ? selected : 'fast';
}

function importMethodLabel(value) {
  return IMPORT_METHODS.find((method) => method.value === value)?.label ?? value;
}

function strategyOptions() {
  return IMPORT_STRATEGIES.map(
    (strategy) => `<option value="${strategy.value}">${strategy.label}</option>`,
  ).join('');
}

function selectedStrategy(selector) {
  const selected = document.querySelector(selector)?.value;
  return IMPORT_STRATEGIES.some((strategy) => strategy.value === selected) ? selected : 'merge';
}

function strategyLabel(value) {
  return IMPORT_STRATEGIES.find((strategy) => strategy.value === value)?.label ?? value;
}

function isCompleteLocalReplacement(strategy) {
  return strategy === 'replace-local';
}

function completeLocalReplacementWarning(strategy) {
  return isCompleteLocalReplacement(strategy)
    ? '⚠ 将清空所有本地数据模块，包括导入包中没有的模块和未勾选的 Secrets/API Key；随后只写入本次选择导入的内容。'
    : '';
}

// 敏感模块（Secrets / API key）自己就是那个开关：勾上它即代表同意导出明文。
function includeSecrets() {
  return (
    document.querySelector('#ptdm-modules input[data-module][data-sensitive]:checked') !== null
  );
}

function notify(type, message) {
  globalThis.toastr?.[type]?.(message);
}

function confirmAction(message, options = {}) {
  const { confirmLabel = '确定', danger = false } = options;
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'ptdm-confirm-dialog';
    dialog.innerHTML = `
      <div class="ptdm-confirm-body">
        <h3>请确认</h3>
        <p></p>
        <div class="ptdm-toolbar ptdm-confirm-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button${danger ? ' ptdm-danger' : ''}" data-action="confirm"></button>
        </div>
      </div>`;
    dialog.querySelector('p').textContent = message;
    dialog.querySelector('[data-action="confirm"]').textContent = confirmLabel;
    document.body.appendChild(dialog);

    let settled = false;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(confirmed);
    };
    dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => finish(false));
    dialog.querySelector('[data-action="confirm"]').addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('close', () => finish(false));
    dialog.showModal();
  });
}

function chooseImportModules(preview, options = {}) {
  const { title = '选择要导入的模块', strategy = 'merge' } = options;
  const modules = Array.isArray(preview?.modules) ? preview.modules : [];
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'ptdm-module-dialog';
    dialog.innerHTML = `
      <div class="ptdm-module-dialog-body">
        <h3></h3>
        <div class="ptdm-muted">模块选择决定从数据包写入哪些内容；导入模式决定这些内容如何处理本地冲突。</div>
        <div class="ptdm-module-selection-warning ptdm-danger ptdm-hidden"></div>
        <div class="ptdm-toolbar ptdm-module-selection-tools">
          <button type="button" class="menu_button" data-action="all">全部选择</button>
          <button type="button" class="menu_button" data-action="none">全部取消</button>
          <span class="ptdm-muted" data-selection-count></span>
        </div>
        <div class="ptdm-module-selection-list"></div>
        <div class="ptdm-toolbar ptdm-confirm-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button" data-action="confirm">继续</button>
        </div>
      </div>`;
    dialog.querySelector('h3').textContent = title;
    const warning = completeLocalReplacementWarning(strategy);
    const warningTarget = dialog.querySelector('.ptdm-module-selection-warning');
    warningTarget.textContent = warning;
    warningTarget.classList.toggle('ptdm-hidden', !warning);

    const list = dialog.querySelector('.ptdm-module-selection-list');
    const inputs = modules.map((module) => {
      const row = document.createElement('label');
      row.className = module.sensitive
        ? 'ptdm-module-selection-row ptdm-danger'
        : 'ptdm-module-selection-row';
      const heading = document.createElement('span');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = module.moduleId;
      input.checked = module.available !== false;
      input.disabled = module.available === false;
      const name = document.createElement('strong');
      name.textContent = module.displayName;
      heading.append(input, name);
      if (module.sensitive) heading.append(' ⚠ Secrets/API Key');
      if (module.available === false) heading.append('（不可用）');
      const meta = document.createElement('span');
      meta.className = 'ptdm-module-meta';
      meta.textContent = module.inspectionOnly
        ? `${module.files} files · ${formatBytes(module.totalBytes)} · 选择后校验内容与冲突`
        : `${module.incomingRecords} records · ${module.incomingBlobs} blobs · ${module.conflicts} conflicts`;
      row.append(heading, meta);
      list.appendChild(row);
      return { input, module };
    });
    const confirm = dialog.querySelector('[data-action="confirm"]');
    const count = dialog.querySelector('[data-selection-count]');
    const update = () => {
      const selected = inputs.filter(({ input }) => input.checked && !input.disabled).length;
      count.textContent = `已选择 ${selected} / ${inputs.filter(({ input }) => !input.disabled).length} 个可用模块`;
      confirm.disabled = selected === 0;
    };
    for (const { input } of inputs) input.addEventListener('change', update);
    dialog.querySelector('[data-action="all"]').addEventListener('click', () => {
      for (const { input } of inputs) if (!input.disabled) input.checked = true;
      update();
    });
    dialog.querySelector('[data-action="none"]').addEventListener('click', () => {
      for (const { input } of inputs) if (!input.disabled) input.checked = false;
      update();
    });

    document.body.appendChild(dialog);
    let settled = false;
    const finish = (selection) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(selection);
    };
    dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => finish(null));
    confirm.addEventListener('click', () => {
      const selected = inputs.filter(({ input }) => input.checked && !input.disabled);
      if (!selected.length) return;
      finish({
        moduleIds: selected.map(({ module }) => module.moduleId),
        includeSecrets: selected.some(({ module }) => module.sensitive),
      });
    });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.addEventListener('close', () => finish(null));
    update();
    dialog.showModal();
  });
}

async function refresh() {
  state.inspection = await postJson(`${API}/inspect`);
  renderInspection();
  renderBackups();
}

function renderInspection() {
  const inspection = state.inspection;
  if (!inspection) return;
  const usage = inspection.quota?.usage ?? 0;
  const quota = inspection.quota?.quota ?? 0;
  const percent = quota ? Math.min(100, (usage / quota) * 100) : 0;
  const persistence = describePersistence(inspection.persistence);
  document.querySelector('#ptdm-summary').innerHTML = `
    <div class="ptdm-card"><strong>${inspection.modules.length}</strong><div>数据模块</div></div>
    <div class="ptdm-card"><strong>${formatBytes(usage)}</strong><div>浏览器用量</div></div>
    <div class="ptdm-card"><strong>${formatBytes(quota)}</strong><div>浏览器配额</div></div>
    <div class="ptdm-card${persistence.danger ? ' ptdm-danger' : ''}"><strong>${persistence.label}</strong><div>存储模式</div></div>
    <div class="ptdm-card"><strong>${inspection.backups.length}</strong><div>本地恢复点</div></div>`;
  const progress = document.querySelector('#ptdm-quota');
  progress.value = percent;
  progress.title = `${percent.toFixed(1)}%`;

  const notice = document.querySelector('#ptdm-persistence');
  notice.textContent = persistence.hint;
  notice.classList.toggle('ptdm-hidden', !persistence.hint);
  notice.classList.toggle('ptdm-danger', persistence.danger);

  const modules = document.querySelector('#ptdm-modules');
  modules.replaceChildren();
  for (const module of inspection.modules) {
    const row = document.createElement('label');
    // 敏感模块用红色行 + ⚠️ 自带警告，默认也勾上：备份通常是给自己用的，缺了 API key 就不完整。
    row.className = module.sensitive ? 'ptdm-module-row ptdm-danger' : 'ptdm-module-row';
    row.innerHTML = `
      <span><input type="checkbox" data-module="${module.moduleId}"${module.sensitive ? ' data-sensitive' : ''} checked>
        <strong></strong>${module.sensitive ? ' ⚠️' : ''}</span>
      <span class="ptdm-module-meta">${module.recordCount} records · ${module.blobCount} blobs · ${formatBytes(module.totalBytes)}</span>`;
    row.querySelector('strong').textContent = module.displayName;
    modules.appendChild(row);
  }
}

// 「尽力而为」不是提示音，是浏览器真的可能在磁盘紧张时把整个库清掉，所以这一格要能变红。
// 但原生壳里数据在应用私有目录，WebView 又永远给不了持久化授权 —— 在那里标红等于天天喊狼来了，
// 用户既处理不了，警告本身也没描述真实风险，久了就会连真警告一起无视。
function describePersistence(persistence) {
  if (persistence?.mode === 'persistent') {
    return { label: '持久化', danger: false, hint: '' };
  }
  if (persistence?.container === 'native-app') {
    return {
      label: '应用私有存储',
      danger: false,
      hint: '数据保存在应用私有目录，系统不会自动清理；但「清除应用数据」或卸载应用会全部删除，建议定期导出 ZIP 备份到本地磁盘。',
    };
  }
  switch (persistence?.mode) {
    case 'best-effort':
      return {
        label: '尽力而为',
        danger: true,
        hint: '浏览器未授予持久化存储：磁盘空间不足时，它可能在不通知的情况下清除本站的全部数据。建议定期导出 ZIP 备份到本地磁盘。',
      };
    case 'unsupported':
      return {
        label: '不支持',
        danger: true,
        hint: '当前浏览器不提供持久化存储接口，数据可能被自动清理。建议定期导出 ZIP 备份到本地磁盘。',
      };
    default:
      return { label: '检测中', danger: false, hint: '' };
  }
}

function renderBackups() {
  const list = document.querySelector('#ptdm-backups');
  list.replaceChildren();
  for (const backup of state.inspection?.backups ?? []) {
    const row = document.createElement('div');
    row.className = 'ptdm-backup-row';
    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = backup.label;
    const meta = document.createElement('div');
    meta.className = 'ptdm-module-meta';
    meta.textContent = `${new Date(backup.createdAt).toLocaleString()} · ${formatBytes(backup.size)} · ${backup.moduleIds.length} modules`;
    info.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'ptdm-toolbar';
    actions.append(
      actionButton('下载', () => downloadBackup(backup.id)),
      actionButton('下载为 TauriTavern 格式', () => downloadBackupAsTauriTavern(backup.id)),
      actionButton('恢复', () => restoreBackup(backup.id), 'menu_button'),
      actionButton('删除', () => deleteBackup(backup.id), 'menu_button ptdm-danger'),
    );
    row.append(info, actions);
    list.appendChild(row);
  }
  if (!list.children.length) list.textContent = '暂无本地恢复点。';
}

function actionButton(label, handler, className = 'menu_button') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', () => void handler());
  return button;
}

async function fetchArchive(path, body, fallbackName = 'pure-tavern-backup.zip') {
  const response = await fetch(path, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    let message = `Archive request failed: HTTP ${response.status}`;
    try {
      message = JSON.parse(text).error || message;
    } catch {
      // 非 JSON 的错误体保持默认文案即可。
    }
    throw new Error(message);
  }
  const disposition = response.headers.get('Content-Disposition') || '';
  const fileName = disposition.match(/filename="([^"]+)"/i)?.[1] || fallbackName;
  return {
    blob: await response.blob(),
    fileName,
    migration: readMigrationHeader(response),
  };
}

function readMigrationHeader(response) {
  const raw = response.headers.get('X-PureTavern-Migration');
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function summarizeMigration(migration) {
  if (!migration) return '';
  const lines = [`共 ${migration.files} 个文件`];
  for (const module of migration.modules ?? []) {
    const parts = [];
    if (module.files) parts.push(`${module.files} 文件`);
    if (module.records) parts.push(`${module.records} 记录`);
    if (module.blobs) parts.push(`${module.blobs} 文件数据`);
    if (module.skipped) parts.push(`跳过 ${module.skipped}`);
    lines.push(
      `${module.moduleId}: ${parts.join(' · ') || '无内容'}${
        module.notes?.length ? `\n    ${module.notes.join('\n    ')}` : ''
      }`,
    );
  }
  for (const warning of migration.warnings ?? []) lines.push(`⚠ ${warning}`);
  return lines.join('\n');
}

async function saveBlob(blob, fileName) {
  const save = globalThis.__PURE_TAVERN_SAVE_FILE__;
  if (typeof save !== 'function') throw new Error('文件保存能力未初始化，请刷新页面后重试。');
  const saved = await save(blob, fileName);
  return {
    cancelled: saved.status === 'cancelled',
    confirmed: saved.status === 'saved',
    fileName: saved.fileName,
    location: saved.location,
  };
}

function notifySavedFile(prefix, result) {
  if (result.cancelled) return;
  const details = `文件：${result.fileName}；位置：${result.location}`;
  if (result.confirmed) {
    notify('success', `${prefix}。${details}`);
    return;
  }
  notify('info', `已将下载请求交给系统处理，Web 页面无法确认文件是否写入。${details}`);
}

async function exportArchive() {
  try {
    const result = await fetchArchive(`${API}/export`, {
      moduleIds: selectedModules(),
      includeSecrets: includeSecrets(),
    });
    const saved = await saveBlob(result.blob, result.fileName);
    notifySavedFile('数据归档已导出', saved);
  } catch (error) {
    notify('error', error.message);
  }
}

async function exportTauriTavern() {
  try {
    const result = await fetchArchive(
      `${TT_API}/export`,
      { moduleIds: selectedModules(), includeSecrets: includeSecrets() },
      'tauritavern-data.zip',
    );
    const saved = await saveBlob(result.blob, result.fileName);
    notifySavedFile('已导出为 TauriTavern 格式', saved);
    showReport(summarizeMigration(result.migration) || '（没有可转换的内容）');
  } catch (error) {
    notify('error', error.message);
  }
}

async function downloadBackupAsTauriTavern(id) {
  try {
    const result = await fetchArchive(`${TT_API}/local/download`, { id }, 'tauritavern-data.zip');
    const saved = await saveBlob(result.blob, result.fileName);
    notifySavedFile('恢复点已导出为 TauriTavern 格式', saved);
    showReport(summarizeMigration(result.migration) || '（没有可转换的内容）');
  } catch (error) {
    notify('error', error.message);
  }
}

async function previewTauriTavernImport(file) {
  state.ttImportAbort?.abort();
  const abort = new AbortController();
  state.ttImportAbort = abort;
  state.ttFile = null;
  state.ttPreview = null;
  document.querySelector('#ptdm-tt-import-confirm').disabled = true;
  const target = document.querySelector('#ptdm-tt-preview');
  target.classList.remove('ptdm-hidden');

  const method = selectedImportMethod();
  const strategy = selectedStrategy('#ptdm-tt-strategy');
  const bridge = globalThis.__PURE_TAVERN_DATA_STREAMING__;
  const inspectionOnly = method === 'slow' && Boolean(bridge?.inspectTauriTavern);
  target.textContent =
    method === 'slow'
      ? inspectionOnly
        ? '正在扫描 TauriTavern ZIP 目录（不会解压文件正文）…'
        : '正在逐文件读取并预览 TauriTavern 数据包（内存占用较低）…'
      : '正在快速读取并预览 TauriTavern 数据包（内存占用较高）…';

  let payload;
  if (inspectionOnly) {
    payload = await bridge.inspectTauriTavern(file, streamingUiOptions(abort, target, '扫描'));
  } else if (bridge?.previewTauriTavern) {
    payload = await bridge.previewTauriTavern(
      file,
      { includeSecrets: true, strategy, createRecoveryPoint: false },
      importExecutionOptions(method, abort, target, '预览'),
    );
  } else {
    const form = new FormData();
    form.set('file', file);
    form.set('includeSecrets', 'true');
    form.set('strategy', strategy);
    form.set('method', method);
    const response = await fetch(`${TT_API}/import/preview`, { method: 'POST', body: form });
    payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Preview failed: HTTP ${response.status}`);
  }

  if (abort.signal.aborted) return;
  state.ttPreview = payload;
  state.ttFile = file;
  target.textContent = [
    `TauriTavern 数据包：${payload.migration.files} 个文件`,
    `导入方式：${importMethodLabel(method)}`,
    `导入模式：${strategyLabel(strategy)}`,
    completeLocalReplacementWarning(strategy),
    `发现 ${payload.modules.length} 个可导入模块 · ${formatBytes(payload.totalBytes)}`,
    inspectionOnly ? '当前仅扫描目录；选择模块后才会逐文件解压并校验内容。' : '',
    ...payload.modules.map((module) =>
      module.inspectionOnly
        ? `${module.selected ? '✓' : '–'} ${module.displayName}: ${module.files} files · ${formatBytes(module.totalBytes)}`
        : `${module.selected ? '✓' : '–'} ${module.displayName}: ${module.incomingRecords} records, ${module.incomingBlobs} blobs, ${module.conflicts} conflicts${module.warnings.length ? ` (${module.warnings.join('; ')})` : ''}`,
    ),
    '',
    summarizeMigration(payload.migration),
  ]
    .filter(Boolean)
    .join('\n');
  document.querySelector('#ptdm-tt-import-confirm').disabled = false;
}

async function importTauriTavern() {
  if (!state.ttFile) return;
  const method = selectedImportMethod();
  const strategy = selectedStrategy('#ptdm-tt-strategy');
  const selection = await chooseImportModules(state.ttPreview, {
    title: '选择要导入的 TauriTavern 模块',
    strategy,
  });
  if (!selection) return;
  const bridge = globalThis.__PURE_TAVERN_DATA_STREAMING__;
  const options = {
    moduleIds: selection.moduleIds,
    includeSecrets: selection.includeSecrets,
    strategy,
    createRecoveryPoint: true,
  };
  const target = document.querySelector('#ptdm-tt-preview');
  const button = document.querySelector('#ptdm-tt-import-confirm');
  button.disabled = true;
  try {
    let exactPreview = state.ttPreview;
    if (method === 'slow' && bridge?.previewTauriTavern) {
      target.textContent = '正在逐文件校验所选模块并分析冲突…';
      exactPreview = await bridge.previewTauriTavern(
        state.ttFile,
        options,
        importExecutionOptions(method, state.ttImportAbort, target, '预览'),
      );
      state.ttPreview = exactPreview;
      target.textContent = formatExactImportPreview(exactPreview, strategy, 'TauriTavern', method);
    }

    const replaceLocal = isCompleteLocalReplacement(strategy);
    const warning = completeLocalReplacementWarning(strategy);
    const selectedIds = new Set(selection.moduleIds);
    const conflicts = (exactPreview?.modules ?? []).reduce(
      (total, module) => total + (selectedIds.has(module.moduleId) ? module.conflicts || 0 : 0),
      0,
    );
    const executionDescription =
      method === 'fast' ? '将整包解压后写入当前浏览器数据库' : '将逐文件写入当前浏览器数据库';
    if (
      !(await confirmAction(
        `${warning ? `${warning}\n\n` : ''}已选择 ${selection.moduleIds.length} 个模块，检测到 ${conflicts} 个冲突。导入模式：${strategyLabel(strategy)}。导入方式：${importMethodLabel(method)}。${executionDescription}，导入前会自动创建恢复点。确定继续吗？`,
        replaceLocal ? { confirmLabel: '清空并导入', danger: true } : {},
      ))
    ) {
      return;
    }

    let payload;
    if (bridge?.importTauriTavern) {
      target.textContent =
        method === 'fast'
          ? '正在快速导入所选 TauriTavern 模块（整包解压）…'
          : '正在逐文件导入所选 TauriTavern 模块…';
      payload = await bridge.importTauriTavern(
        state.ttFile,
        options,
        importExecutionOptions(method, state.ttImportAbort, target, '导入'),
      );
    } else {
      const form = new FormData();
      form.set('file', state.ttFile);
      form.set('modules', JSON.stringify(selection.moduleIds));
      form.set('includeSecrets', String(selection.includeSecrets));
      form.set('strategy', strategy);
      form.set('createRecoveryPoint', 'true');
      form.set('method', method);
      const response = await fetch(`${TT_API}/import`, { method: 'POST', body: form });
      payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Import failed: HTTP ${response.status}`);
    }
    showReport(payload);
    notify('success', 'TauriTavern 数据导入完成，页面即将刷新。');
    setTimeout(() => location.reload(), 500);
  } finally {
    button.disabled = false;
  }
}

async function createBackup() {
  try {
    const descriptor = await postJson(`${API}/local/create`, {
      label: `Manual backup ${new Date().toLocaleString()}`,
      moduleIds: selectedModules(),
      includeSecrets: includeSecrets(),
    });
    notify('success', `恢复点已创建：${descriptor.label}`);
    await refresh();
  } catch (error) {
    notify('error', error.message);
  }
}

async function downloadBackup(id) {
  try {
    const result = await fetchArchive(`${API}/local/download`, { id });
    const saved = await saveBlob(result.blob, result.fileName);
    notifySavedFile('恢复点已导出', saved);
  } catch (error) {
    notify('error', error.message);
  }
}

async function deleteBackup(id) {
  if (!(await confirmAction('确定删除这个本地恢复点吗？', { confirmLabel: '删除', danger: true })))
    return;
  try {
    await postJson(`${API}/local/delete`, { id });
    await refresh();
  } catch (error) {
    notify('error', error.message);
  }
}

async function restoreBackup(id) {
  const strategy = selectedStrategy('#ptdm-strategy');
  const replaceLocal = isCompleteLocalReplacement(strategy);
  const warning = completeLocalReplacementWarning(strategy);
  if (
    !(await confirmAction(
      `${warning ? `${warning}\n\n` : ''}恢复会修改当前数据，并自动创建恢复前快照。是否继续？`,
      replaceLocal ? { confirmLabel: '清空并恢复', danger: true } : {},
    ))
  )
    return;
  try {
    const report = await postJson(`${API}/local/restore`, {
      id,
      strategy,
      includeSecrets: includeSecrets(),
    });
    showReport(report);
    notify('success', '恢复完成，页面即将刷新。');
    setTimeout(() => location.reload(), 500);
  } catch (error) {
    notify('error', error.message);
  }
}

async function previewImport(file) {
  state.importAbort?.abort();
  const abort = new AbortController();
  state.importAbort = abort;
  state.selectedFile = null;
  state.preview = null;
  document.querySelector('#ptdm-import-confirm').disabled = true;
  const target = document.querySelector('#ptdm-preview');
  target.classList.remove('ptdm-hidden');
  const method = selectedImportMethod();
  const strategy = selectedStrategy('#ptdm-strategy');
  const bridge = globalThis.__PURE_TAVERN_DATA_STREAMING__;
  const inspectionOnly = method === 'slow' && Boolean(bridge?.inspectArchive);
  target.textContent =
    method === 'slow'
      ? inspectionOnly
        ? '正在读取 PureTavern manifest 与 ZIP 目录（不会解压模块正文）…'
        : '正在逐文件读取并预览 PureTavern 数据包（内存占用较低）…'
      : '正在快速读取并预览 PureTavern 数据包（内存占用较高）…';

  let payload;
  if (inspectionOnly) {
    payload = await bridge.inspectArchive(file, streamingUiOptions(abort, target, '扫描'));
  } else if (bridge?.previewArchive) {
    payload = await bridge.previewArchive(
      file,
      { includeSecrets: true, strategy, createRecoveryPoint: false },
      importExecutionOptions(method, abort, target, '预览'),
    );
  } else {
    const form = new FormData();
    form.set('file', file);
    form.set('includeSecrets', 'true');
    form.set('strategy', strategy);
    form.set('method', method);
    const response = await fetch(`${API}/import/preview`, { method: 'POST', body: form });
    payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Preview failed: HTTP ${response.status}`);
  }
  if (abort.signal.aborted) return;
  state.preview = payload;
  state.selectedFile = file;
  target.textContent = [
    `Archive: ${payload.manifest.archiveId}`,
    `Created: ${payload.manifest.createdAt}`,
    `导入方式：${importMethodLabel(method)}`,
    `导入模式：${strategyLabel(strategy)}`,
    completeLocalReplacementWarning(strategy),
    `Modules: ${payload.modules.length}`,
    `Payload: ${formatBytes(payload.totalBytes)}`,
    inspectionOnly ? '当前仅校验 manifest/目录；选择模块后才会逐文件校验 SHA-256 与冲突。' : '',
    ...payload.modules.map(
      (module) =>
        `${module.selected ? '✓' : '–'} ${module.displayName}: ${module.incomingRecords} records, ${module.incomingBlobs} blobs${inspectionOnly ? '' : `, ${module.conflicts} conflicts`}${module.warnings.length ? ` (${module.warnings.join('; ')})` : ''}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');
  document.querySelector('#ptdm-import-confirm').disabled = false;
}

async function importArchive() {
  if (!state.selectedFile) return;
  const method = selectedImportMethod();
  const strategy = selectedStrategy('#ptdm-strategy');
  const selection = await chooseImportModules(state.preview, {
    title: '选择要导入的 PureTavern 模块',
    strategy,
  });
  if (!selection) return;
  const bridge = globalThis.__PURE_TAVERN_DATA_STREAMING__;
  const options = {
    moduleIds: selection.moduleIds,
    includeSecrets: selection.includeSecrets,
    strategy,
    createRecoveryPoint: true,
  };
  const target = document.querySelector('#ptdm-preview');
  const button = document.querySelector('#ptdm-import-confirm');
  button.disabled = true;
  try {
    let exactPreview = state.preview;
    if (method === 'slow' && bridge?.previewArchive) {
      target.textContent = '正在逐文件校验所选模块的 CRC、SHA-256 与冲突…';
      exactPreview = await bridge.previewArchive(
        state.selectedFile,
        options,
        importExecutionOptions(method, state.importAbort, target, '预览'),
      );
      state.preview = exactPreview;
      target.textContent = formatExactImportPreview(exactPreview, strategy, 'PureTavern', method);
    }
    const replaceLocal = isCompleteLocalReplacement(strategy);
    const warning = completeLocalReplacementWarning(strategy);
    const selectedIds = new Set(selection.moduleIds);
    const conflicts = (exactPreview?.modules ?? []).reduce(
      (total, module) => total + (selectedIds.has(module.moduleId) ? module.conflicts || 0 : 0),
      0,
    );
    const executionDescription = method === 'fast' ? '整包解压后写入' : '逐文件校验并写入';
    if (
      !(await confirmAction(
        `${warning ? `${warning}\n\n` : ''}已选择 ${selection.moduleIds.length} 个模块，检测到 ${conflicts} 个冲突。导入方式：${importMethodLabel(method)}。导入前会自动创建恢复点，并${executionDescription}。确定继续吗？`,
        replaceLocal ? { confirmLabel: '清空并导入', danger: true } : {},
      ))
    )
      return;

    let payload;
    if (bridge?.importArchive) {
      target.textContent =
        method === 'fast'
          ? '正在快速导入 PureTavern 数据（整包解压）…'
          : '正在逐文件导入 PureTavern 数据…';
      payload = await bridge.importArchive(
        state.selectedFile,
        options,
        importExecutionOptions(method, state.importAbort, target, '导入'),
      );
    } else {
      const form = new FormData();
      form.set('file', state.selectedFile);
      form.set('modules', JSON.stringify(selection.moduleIds));
      form.set('includeSecrets', String(selection.includeSecrets));
      form.set('strategy', strategy);
      form.set('createRecoveryPoint', 'true');
      form.set('method', method);
      const response = await fetch(`${API}/import`, { method: 'POST', body: form });
      payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Import failed: HTTP ${response.status}`);
    }
    showReport(payload);
    notify('success', '数据导入完成，页面即将刷新。');
    setTimeout(() => location.reload(), 500);
  } finally {
    button.disabled = false;
  }
}

function showReport(report) {
  const target = document.querySelector('#ptdm-report');
  target.classList.remove('ptdm-hidden');
  target.textContent = typeof report === 'string' ? report : JSON.stringify(report, null, 2);
}

// ── 云端同步 ────────────────────────────────────────────────────────────────
// 面板只负责显示与收集输入；派生密钥、加解密、HTTP 全在 __PURE_TAVERN_SYNC_VAULT__ 里。
// 所以这个文件里看不到 password 之外的任何密钥材料，也永远拿不到明文以外的字节。

function syncBridge() {
  return globalThis.__PURE_TAVERN_SYNC_VAULT__ ?? null;
}

function syncStatusText() {
  if (!syncBridge()) return '云端同步模块未加载，请刷新页面。';
  if (!syncState.unlocked) return '未解锁。解锁后本机不会保存密码，关掉标签页即锁定。';
  return `已解锁：${syncState.unlocked.username} @ ${syncState.unlocked.baseUrl}`;
}

function renderSync() {
  const status = document.querySelector('#ptdm-sync-status');
  if (!status) return;
  const unlocked = Boolean(syncState.unlocked);
  status.textContent = syncStatusText();
  status.classList.toggle('ptdm-danger', !syncBridge());
  document.querySelector('#ptdm-sync-actions').classList.toggle('ptdm-hidden', !unlocked);
  document.querySelector('#ptdm-sync-auth').classList.toggle('ptdm-hidden', unlocked);
  renderSyncSnapshots();
}

function renderSyncSnapshots() {
  const list = document.querySelector('#ptdm-sync-list');
  if (!list) return;
  list.replaceChildren();
  if (!syncState.unlocked) {
    list.textContent = '解锁后这里会列出云端快照。';
    return;
  }
  for (const snapshot of syncState.snapshots) {
    const row = document.createElement('div');
    row.className = 'ptdm-backup-row';
    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = snapshot.label;
    const meta = document.createElement('div');
    meta.className = 'ptdm-module-meta';
    // 大小显示的是密文体积：云上真正占的字节，明文体积在这里没有意义。
    meta.textContent = `${new Date(snapshot.createdAt).toLocaleString()} · ${formatBytes(snapshot.size)} · ${snapshot.moduleIds.length} modules${snapshot.includeSecrets ? ' · 含 Secrets' : ''}`;
    info.append(title, meta);
    const actions = document.createElement('div');
    actions.className = 'ptdm-toolbar';
    actions.append(
      actionButton('下载到本地', () => downloadSyncSnapshot(snapshot)),
      actionButton('恢复到本地', () => restoreSyncSnapshot(snapshot)),
      actionButton('删除云端', () => deleteSyncSnapshot(snapshot), 'menu_button ptdm-danger'),
    );
    row.append(info, actions);
    list.appendChild(row);
  }
  if (!list.children.length) list.textContent = '云端还没有快照。点「上传当前数据」创建第一个。';
}

function selectedSyncLabel() {
  const value = document.querySelector('#ptdm-sync-label')?.value?.trim();
  return value || '';
}

async function unlockSync() {
  const bridge = syncBridge();
  if (!bridge) {
    notify('error', '云端同步模块未加载，请刷新页面。');
    return;
  }
  const baseUrl = document.querySelector('#ptdm-sync-endpoint').value.trim();
  const username = document.querySelector('#ptdm-sync-username').value.trim();
  const password = document.querySelector('#ptdm-sync-password').value;
  const register = document.querySelector('#ptdm-sync-register').checked;
  const remember = document.querySelector('#ptdm-sync-remember').checked;
  const button = document.querySelector('#ptdm-sync-unlock');
  button.disabled = true;
  try {
    const result = await bridge.unlock({ baseUrl, username, password, register, remember });
    syncState.unlocked = result.state;
    syncState.snapshots = result.snapshots;
    // 密码立刻从 DOM 里抹掉：它不是「输入框里的值」，是以后能解开全部数据的钥匙。
    document.querySelector('#ptdm-sync-password').value = '';
    renderSync();
    notify('success', register ? '已创建云端保险库并解锁。' : '已解锁云端保险库。');
  } catch (error) {
    notify('error', error.message);
  } finally {
    button.disabled = false;
  }
}

function lockSync() {
  syncBridge()?.lock();
  syncState.unlocked = null;
  syncState.snapshots = [];
  document.querySelector('#ptdm-sync-password').value = '';
  renderSync();
  notify('info', '已锁定。派生密钥已从内存丢弃。');
}

async function refreshSyncSnapshots() {
  const bridge = syncBridge();
  if (!bridge || !syncState.unlocked) return;
  try {
    // 重新解锁一次代价太高（PBKDF2 60 万轮），所以「刷新」只是重读索引——
    // 由 bridge 暴露的 list 返回当前内存索引；真正的跨设备刷新靠重新解锁。
    syncState.snapshots = bridge.list();
    renderSyncSnapshots();
    notify('info', '已刷新本机看到的快照列表。跨设备的最新列表需要重新解锁。');
  } catch (error) {
    notify('error', error.message);
  }
}

async function uploadSyncSnapshot() {
  const bridge = syncBridge();
  if (!bridge || !syncState.unlocked) return;
  const button = document.querySelector('#ptdm-sync-upload');
  button.disabled = true;
  try {
    syncState.snapshots = await bridge.upload({
      label: selectedSyncLabel(),
      moduleIds: selectedModules(),
      includeSecrets: includeSecrets(),
    });
    renderSyncSnapshots();
    notify('success', '已加密并上传到云端。');
  } catch (error) {
    notify('error', error.message);
  } finally {
    button.disabled = false;
  }
}

async function downloadSyncSnapshot(snapshot) {
  const bridge = syncBridge();
  if (!bridge) return;
  try {
    const result = await bridge.download(snapshot.id);
    const saved = await saveBlob(result.blob, result.fileName);
    notifySavedFile('云端快照已导出', saved);
  } catch (error) {
    notify('error', error.message);
  }
}

async function restoreSyncSnapshot(snapshot) {
  const bridge = syncBridge();
  if (!bridge) return;
  const strategy = selectedStrategy('#ptdm-sync-strategy');
  const replaceLocal = isCompleteLocalReplacement(strategy);
  if (
    !(await confirmAction(
      `即将用云端快照「${snapshot.label}」覆盖本地数据。\n导入模式：${strategyLabel(strategy)}。\n导入前会自动创建本地恢复点。确定继续吗？`,
      replaceLocal ? { confirmLabel: '清空并恢复', danger: true } : {},
    ))
  )
    return;
  const target = document.querySelector('#ptdm-sync-report');
  target.classList.remove('ptdm-hidden');
  target.textContent = '正在从云端解密快照…';
  try {
    const result = await bridge.download(snapshot.id);
    const file = new File([result.blob], result.fileName, { type: 'application/zip' });
    const form = new FormData();
    form.set('file', file);
    form.set('includeSecrets', String(snapshot.includeSecrets));
    form.set('strategy', strategy);
    form.set('createRecoveryPoint', 'true');
    form.set('method', 'slow');
    target.textContent = '正在导入快照（会先创建恢复点）…';
    const response = await fetch(`${API}/import`, { method: 'POST', body: form });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `导入失败：HTTP ${response.status}`);
    target.textContent = JSON.stringify(payload, null, 2);
    notify('success', '云端快照已恢复，页面即将刷新。');
    setTimeout(() => location.reload(), 500);
  } catch (error) {
    target.classList.remove('ptdm-hidden');
    target.textContent = error.message;
    notify('error', error.message);
  }
}

async function deleteSyncSnapshot(snapshot) {
  const bridge = syncBridge();
  if (!bridge) return;
  if (
    !(await confirmAction(`从云端删除「${snapshot.label}」？这条快照在所有设备上都看不到了。`, {
      confirmLabel: '删除',
      danger: true,
    }))
  )
    return;
  try {
    syncState.snapshots = await bridge.remove(snapshot.id);
    renderSyncSnapshots();
    notify('success', '已从云端删除。');
  } catch (error) {
    notify('error', error.message);
  }
}

function bindFilePicker(dialog, inputSelector, labelSelector, preview) {
  dialog.querySelector(inputSelector).addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    const fileName = dialog.querySelector(labelSelector);
    if (!file) {
      fileName.textContent = '尚未选择文件';
      fileName.title = '尚未选择文件';
      return;
    }
    fileName.textContent = file.name;
    fileName.title = file.name;
    try {
      await preview(file);
    } catch (error) {
      notify('error', error.message);
    }
  });
}

function bindConfirm(dialog, selector, action) {
  dialog.querySelector(selector).addEventListener('click', async () => {
    try {
      await action();
    } catch (error) {
      notify('error', error.message);
    }
  });
}

function createUi() {
  if (document.querySelector('#pure-tavern-data-management-entry')) return;
  const entry = document.createElement('section');
  entry.id = 'pure-tavern-data-management-entry';
  entry.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>PureTavern 数据管理</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <button type="button" class="menu_button">打开数据管理</button>
      </div>
    </div>`;
  (document.querySelector('#extensions_settings2') || document.body).prepend(entry);

  const dialog = document.createElement('dialog');
  dialog.id = 'pure-tavern-data-management-dialog';
  dialog.innerHTML = `
    <div class="ptdm-header"><div><h2>PureTavern 数据管理</h2><div class="ptdm-muted">本地归档与灾难恢复中心</div></div><button type="button" class="menu_button" id="ptdm-close">关闭</button></div>
    <div class="ptdm-body">
      <div id="ptdm-summary" class="ptdm-grid"></div>
      <progress id="ptdm-quota" class="ptdm-progress" max="100" value="0"></progress>
      <div id="ptdm-persistence" class="ptdm-muted ptdm-hidden"></div>
      <section class="ptdm-section"><h3>本地模块（仅用于导出与创建恢复点）</h3><div id="ptdm-modules"></div></section>
      <section class="ptdm-section"><h3>手动导出</h3><div class="ptdm-toolbar"><button id="ptdm-export" class="menu_button">导出 ZIP</button><button id="ptdm-tt-export" class="menu_button">导出为 TauriTavern 格式</button><button id="ptdm-create-backup" class="menu_button">创建本地恢复点</button></div><div class="ptdm-muted">TauriTavern 格式即 SillyTavern 的 data/default-user 目录，可直接被 TauriTavern 的数据迁移扩展导入。</div></section>
      <section class="ptdm-section"><h3>导入与恢复</h3><div class="ptdm-toolbar ptdm-import-method-row"><label class="ptdm-strategy-control" for="ptdm-import-method"><span>导入方式</span><select id="ptdm-import-method" aria-label="整体导入方式">${importMethodOptions()}</select></label><span class="ptdm-muted">如果遇到导入卡死等问题，建议使用慢速导入。</span></div><div class="ptdm-toolbar"><input id="ptdm-import-file" class="ptdm-hidden" type="file" accept=".zip,application/zip,application/x-zip-compressed"><label for="ptdm-import-file" class="menu_button ptdm-file-picker">选择数据 ZIP</label><span id="ptdm-import-file-name" class="ptdm-muted" title="尚未选择文件">尚未选择文件</span><label class="ptdm-strategy-control" for="ptdm-strategy"><span>导入模式</span><select id="ptdm-strategy" aria-label="数据 ZIP 导入模式">${strategyOptions()}</select></label><button id="ptdm-import-confirm" class="menu_button" disabled>执行导入</button></div><pre id="ptdm-preview" class="ptdm-report ptdm-hidden"></pre>
        <div class="ptdm-toolbar ptdm-interop-row"><input id="ptdm-tt-import-file" class="ptdm-hidden" type="file" accept=".zip,application/zip,application/x-zip-compressed"><label for="ptdm-tt-import-file" class="menu_button ptdm-file-picker">导入 TauriTavern 数据</label><span id="ptdm-tt-import-file-name" class="ptdm-muted" title="尚未选择文件">尚未选择文件</span><label class="ptdm-strategy-control" for="ptdm-tt-strategy"><span>导入模式</span><select id="ptdm-tt-strategy" aria-label="TauriTavern 导入模式">${strategyOptions()}</select></label><button id="ptdm-tt-import-confirm" class="menu_button" disabled>执行 TauriTavern 导入</button></div><div class="ptdm-muted">接受 TauriTavern / SillyTavern 导出的数据包，可独立选择冲突处理模式；导入前会自动创建恢复点。</div><pre id="ptdm-tt-preview" class="ptdm-report ptdm-hidden"></pre>
        <pre id="ptdm-report" class="ptdm-report ptdm-hidden"></pre></section>
      <section class="ptdm-section"><h3>本地恢复点</h3><div id="ptdm-backups"></div></section>
      <section class="ptdm-section"><h3>云端同步（端到端加密）</h3><div class="ptdm-muted">快照上传前在本机加密，密钥由同步密码派生，从不上传。服务器只存密文，所以忘记密码后无法找回，也无法解密。</div><div id="ptdm-sync-status" class="ptdm-muted">未解锁。</div><div id="ptdm-sync-auth"><div class="ptdm-toolbar"><label class="ptdm-strategy-control" for="ptdm-sync-endpoint"><span>后端地址</span><input id="ptdm-sync-endpoint" type="url" placeholder="https://pure-tavern-backend.&lt;子域&gt;.workers.dev/" spellcheck="false"></label></div><div class="ptdm-toolbar"><label class="ptdm-strategy-control" for="ptdm-sync-username"><span>用户名</span><input id="ptdm-sync-username" type="text" placeholder="3–32 位小写" spellcheck="false" autocomplete="username"></label><label class="ptdm-strategy-control" for="ptdm-sync-password"><span>同步密码</span><input id="ptdm-sync-password" type="password" autocomplete="current-password"></label></div><div class="ptdm-toolbar"><label class="ptdm-check"><input id="ptdm-sync-register" type="checkbox"> 首次使用，创建新保险库</label><label class="ptdm-check"><input id="ptdm-sync-remember" type="checkbox" checked> 记住地址与用户名（不记密码）</label><button id="ptdm-sync-unlock" class="menu_button">解锁</button></div></div><div class="ptdm-toolbar ptdm-hidden" id="ptdm-sync-actions"><label class="ptdm-strategy-control" for="ptdm-sync-label"><span>快照名</span><input id="ptdm-sync-label" type="text" placeholder="留空则用时间戳"></label><button id="ptdm-sync-upload" class="menu_button ptdm-hidden">上传当前数据</button><button id="ptdm-sync-refresh" class="menu_button ptdm-hidden">刷新列表</button><button id="ptdm-sync-lock" class="menu_button ptdm-hidden">锁定</button><label class="ptdm-strategy-control" for="ptdm-sync-strategy"><span>恢复模式</span><select id="ptdm-sync-strategy" aria-label="云端快照恢复模式">${strategyOptions()}</select></label></div><div id="ptdm-sync-list">解锁后这里会列出云端快照。</div><pre id="ptdm-sync-report" class="ptdm-report ptdm-hidden"></pre></section>
    </div>`;
  document.body.appendChild(dialog);

  entry.querySelector('button').addEventListener('click', async () => {
    dialog.showModal();
    prefillSyncForm();
    renderSync();
    try {
      await refresh();
    } catch (error) {
      notify('error', error.message);
    }
  });
  dialog.querySelector('#ptdm-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    state.importAbort?.abort();
    state.ttImportAbort?.abort();
    state.importAbort = null;
    state.ttImportAbort = null;
    state.selectedFile = null;
    state.preview = null;
    state.ttFile = null;
    state.ttPreview = null;
    for (const [inputSelector, nameSelector, buttonSelector] of [
      ['#ptdm-import-file', '#ptdm-import-file-name', '#ptdm-import-confirm'],
      ['#ptdm-tt-import-file', '#ptdm-tt-import-file-name', '#ptdm-tt-import-confirm'],
    ]) {
      dialog.querySelector(inputSelector).value = '';
      const name = dialog.querySelector(nameSelector);
      name.textContent = '尚未选择文件';
      name.title = '尚未选择文件';
      dialog.querySelector(buttonSelector).disabled = true;
    }
    dialog.querySelector('#ptdm-preview').classList.add('ptdm-hidden');
    dialog.querySelector('#ptdm-tt-preview').classList.add('ptdm-hidden');
  });
  dialog.querySelector('#ptdm-export').addEventListener('click', () => void exportArchive());
  dialog.querySelector('#ptdm-tt-export').addEventListener('click', () => void exportTauriTavern());
  dialog.querySelector('#ptdm-create-backup').addEventListener('click', () => void createBackup());
  bindFilePicker(dialog, '#ptdm-import-file', '#ptdm-import-file-name', previewImport);
  bindFilePicker(
    dialog,
    '#ptdm-tt-import-file',
    '#ptdm-tt-import-file-name',
    previewTauriTavernImport,
  );
  bindConfirm(dialog, '#ptdm-import-confirm', importArchive);
  bindConfirm(dialog, '#ptdm-tt-import-confirm', importTauriTavern);
  dialog.querySelector('#ptdm-import-method').addEventListener('change', () => {
    const archiveFile = state.selectedFile;
    const tauriTavernFile = state.ttFile;
    if (archiveFile) {
      void previewImport(archiveFile).catch((error) => notify('error', error.message));
    }
    if (tauriTavernFile) {
      void previewTauriTavernImport(tauriTavernFile).catch((error) =>
        notify('error', error.message),
      );
    }
  });
  dialog.querySelector('#ptdm-strategy').addEventListener('change', () => {
    const file = state.selectedFile;
    if (!file) return;
    void previewImport(file).catch((error) => notify('error', error.message));
  });
  dialog.querySelector('#ptdm-tt-strategy').addEventListener('change', () => {
    const file = state.ttFile;
    if (!file) return;
    void previewTauriTavernImport(file).catch((error) => notify('error', error.message));
  });
  dialog.querySelector('#ptdm-sync-unlock').addEventListener('click', () => void unlockSync());
  dialog
    .querySelector('#ptdm-sync-upload')
    .addEventListener('click', () => void uploadSyncSnapshot());
  dialog
    .querySelector('#ptdm-sync-refresh')
    .addEventListener('click', () => void refreshSyncSnapshots());
  dialog.querySelector('#ptdm-sync-lock').addEventListener('click', () => lockSync());
  // 密码框回车直接解锁：填完密码还要去点按钮，是让人把密码重复敲一遍的唯一理由。
  dialog.querySelector('#ptdm-sync-password').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void unlockSync();
    }
  });
  globalThis.__PURE_TAVERN_DATA_MANAGEMENT__ = {
    installed: true,
    open: () => entry.querySelector('button').click(),
    refresh,
  };
}

function prefillSyncForm() {
  const bridge = syncBridge();
  if (!bridge) return;
  const remembered = bridge.remembered();
  const endpoint = document.querySelector('#ptdm-sync-endpoint');
  const username = document.querySelector('#ptdm-sync-username');
  // 只在空的时候填，避免覆盖用户正在输入的内容。
  if (endpoint && !endpoint.value && remembered.baseUrl) endpoint.value = remembered.baseUrl;
  if (username && !username.value && remembered.username) username.value = remembered.username;
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', createUi, { once: true });
else createUi();
