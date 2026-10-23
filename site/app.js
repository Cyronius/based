'use strict';

const icons = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const examples = {
  mssql: {
    label: 'SQL Server', host: 'localhost', database: 'AdventureWorks', schema: 'dbo', folder: 'Stored Procedures', secondary: 'master',
    tables: ['Customer', 'CustomerAddress', 'Product', 'SalesOrderHeader', 'SalesOrderDetail'],
    queryName: 'High value products',
    sql: 'SELECT TOP (50)\n    p.ProductID,\n    p.Name,\n    SUM(od.OrderQty) AS TotalQuantity,\n    SUM(od.LineTotal) AS TotalRevenue\nFROM Production.Product p\nJOIN Sales.SalesOrderDetail od ON p.ProductID = od.ProductID\nGROUP BY p.ProductID, p.Name\nORDER BY TotalRevenue DESC;',
    headers: ['ProductID', 'Name', 'TotalQuantity', 'TotalRevenue'],
    rows: [[680, 'Road-750 Black, 58', 1240, 351980.16], [707, 'Mountain-200 Silver, 38', 840, 229260.20], [711, 'Mountain-200 Silver, 42', 800, 222601.64], [714, 'Mountain-200 Black, 38', 771, 210450.32], [715, 'Mountain-200 Black, 42', 744, 207559.62], [717, 'Mountain-200 Black, 48', 703, 206328.35]],
    message: 'I found high value products from your open tabs and added a new query with the results.',
    tableQuery: name => `SELECT TOP (50) *\nFROM ${name === 'Product' ? 'Production' : name.startsWith('Sales') ? 'Sales' : 'Person'}.${name};`,
    regionSql: 'SELECT c.Region,\n    COUNT(*) AS Customers\nFROM demo.Customers c\nGROUP BY c.Region\nORDER BY Customers DESC;'
  },
  snowflake: {
    label: 'Snowflake', host: 'analytics', database: 'ANALYTICS', schema: 'PUBLIC', folder: 'Stages', secondary: 'RAW',
    tables: ['CUSTOMERS', 'ORDERS', 'ORDER_ITEMS', 'PRODUCTS', 'REGIONS'], queryName: 'Top customers',
    sql: 'SELECT\n    c.CUSTOMER_ID,\n    c.NAME,\n    COUNT(o.ORDER_ID) AS ORDERS,\n    SUM(o.AMOUNT) AS TOTAL_SPEND\nFROM PUBLIC.CUSTOMERS c\nJOIN PUBLIC.ORDERS o ON c.CUSTOMER_ID = o.CUSTOMER_ID\nGROUP BY c.CUSTOMER_ID, c.NAME\nORDER BY TOTAL_SPEND DESC\nLIMIT 50;',
    headers: ['CUSTOMER_ID', 'NAME', 'ORDERS', 'TOTAL_SPEND'],
    rows: [[1001, 'Alpine Works', 42, 128450.20], [1002, 'Northwind Traders', 37, 92310.40], [1003, 'Beacon Systems', 31, 87660.00], [1004, 'Metro Supply', 28, 68904.15], [1005, 'Contoso', 25, 61450.60], [1006, 'Blue Yonder', 21, 58031.20]],
    message: 'I read your open customer and order tabs, then opened a new query with the top customers.',
    tableQuery: name => `SELECT *\nFROM PUBLIC.${name}\nLIMIT 50;`, regionSql: 'SELECT REGION,\n    COUNT(*) AS CUSTOMERS\nFROM PUBLIC.CUSTOMERS\nGROUP BY REGION\nORDER BY CUSTOMERS DESC;'
  },
  lance: {
    label: 'LanceDB', host: 'local folder', database: 'catalog', schema: 'tables', folder: 'Indexes', secondary: 'embeddings',
    tables: ['products', 'documents', 'reviews', 'categories', 'embeddings'], queryName: 'Explore the product catalog',
    sql: '-- SQL over local LanceDB tables through DuckDB\nSELECT\n    product_id,\n    name,\n    category,\n    price\nFROM products\nWHERE category = \'Outdoor\'\nORDER BY price DESC\nLIMIT 50;',
    headers: ['product_id', 'name', 'category', 'price'],
    rows: [[201, 'Alpine Shell Jacket', 'Outdoor', 189.00], [202, 'Summit Pack 30L', 'Outdoor', 139.00], [203, 'Trail Running Vest', 'Outdoor', 95.00], [204, 'Camp Lantern', 'Outdoor', 49.00], [205, 'Merino Trail Socks', 'Outdoor', 24.00], [206, 'Trail Bottle', 'Outdoor', 18.50]],
    message: 'I explored your local product catalog and opened a new tab with the matching rows.',
    tableQuery: name => `SELECT *\nFROM ${name}\nLIMIT 50;`, regionSql: 'SELECT category,\n    COUNT(*) AS products\nFROM products\nGROUP BY category\nORDER BY products DESC;'
  }
};

const state = { engine: 'mssql', tabs: [], selected: 'agent', sort: null, queryCounter: 0, busy: false };
const $ = selector => document.querySelector(selector);
const status = message => { $('#demo-status').textContent = message; };
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const regionRows = [['North America', 42], ['Europe', 31], ['Asia Pacific', 24], ['Latin America', 18]];

function highlight(sql) {
  const token = /(--[^\n]*|'(?:''|[^'])*'|\b(?:SELECT|TOP|FROM|JOIN|ON|GROUP|BY|ORDER|DESC|ASC|WHERE|LIMIT|AS|AND)\b|\b(?:SUM|COUNT)\b)/gi;
  return sql.split('\n').map((line, i) => `<span class="code-line"><span class="line-no" aria-hidden="true">${i + 1}</span>${line.split(token).map(part => {
    const cls = part.startsWith('--') ? 'sql-comment' : part.startsWith("'") ? 'sql-string' : /^(SUM|COUNT)$/i.test(part) ? 'sql-function' : /^(SELECT|TOP|FROM|JOIN|ON|GROUP|BY|ORDER|DESC|ASC|WHERE|LIMIT|AS|AND)$/i.test(part) ? 'sql-keyword' : '';
    return cls ? `<span class="${cls}">${escapeHtml(part)}</span>` : escapeHtml(part);
  }).join('')}</span>`).join('');
}

function seedTabs() {
  const example = examples[state.engine];
  state.tabs = [
    state.engine === 'lance'
      ? { id: 'orders', label: 'Product catalog', sql: example.sql, headers: example.headers, rows: example.rows }
      : { id: 'orders', label: 'Orders by month', sql: state.engine === 'mssql' ? "SELECT FORMAT(OrderDate, 'yyyy-MM') AS Month,\n    COUNT(*) AS Orders\nFROM Sales.SalesOrderHeader\nGROUP BY FORMAT(OrderDate, 'yyyy-MM')\nORDER BY Month;" : "SELECT DATE_TRUNC('MONTH', ORDER_DATE) AS MONTH,\n    COUNT(*) AS ORDERS\nFROM PUBLIC.ORDERS\nGROUP BY MONTH\nORDER BY MONTH;", headers: ['Month', 'Orders'], rows: [['January', 18], ['February', 24], ['March', 31], ['April', 42]] },
    state.engine === 'lance'
      ? { id: 'customers', label: 'Documents', sql: 'SELECT id, title\nFROM documents\nLIMIT 50;', headers: ['id', 'title'], rows: [[1, 'Product catalog notes'], [2, 'Outdoor collection'], [3, 'Material specifications'], [4, 'Care instructions']] }
      : { id: 'customers', label: 'Top customers', sql: state.engine === 'mssql' ? "SELECT TOP (50) c.CustomerID,\n    p.FirstName + ' ' + p.LastName AS Customer,\n    SUM(o.TotalDue) AS TotalSpend\nFROM Sales.Customer c\nJOIN Person.Person p ON c.PersonID = p.BusinessEntityID\nJOIN Sales.SalesOrderHeader o ON c.CustomerID = o.CustomerID\nGROUP BY c.CustomerID, p.FirstName, p.LastName\nORDER BY TotalSpend DESC;" : example.sql, headers: ['CustomerID', 'Customer', 'TotalSpend'], rows: [[1001, 'Alpine Works', 128450.20], [1002, 'Northwind Traders', 92310.40], [1003, 'Beacon Systems', 87660.00], [1004, 'Metro Supply', 68904.15]] },
    { id: 'agent', label: `${example.queryName} (agent)`, sql: example.sql, headers: example.headers, rows: example.rows }
  ];
  state.selected = 'agent';
}

function renderObjects() {
  const query = $('#object-search').value.toLowerCase();
  const tables = examples[state.engine].tables.filter(name => name.toLowerCase().includes(query));
  $('#table-objects').innerHTML = tables.map((name, i) => `<button class="table-object${i === 0 ? ' selected' : ''}" data-table="${name}">${icons('grid')}<span>${state.engine === 'mssql' ? 'dbo.' : ''}${name}</span></button>`).join('');
  $('#empty-search').hidden = tables.length > 0;
}

function renderTabs(newId) {
  $('#query-tabs').innerHTML = state.tabs.map((tab, i) => `<button class="query-tab${tab.id === state.selected ? ' selected' : ''}${tab.id === newId ? ' newly-opened' : ''}" id="query-${tab.id}" role="tab" aria-selected="${tab.id === state.selected}" aria-controls="query-panel" tabindex="${tab.id === state.selected ? 0 : -1}" data-query="${tab.id}" title="Select query. Press Delete to close this tab."><span class="number">${i + 1}</span>${escapeHtml(tab.label)}<span class="query-close" data-close="${tab.id}" aria-hidden="true">${icons('close', 'tiny')}</span></button>`).join('') + '<button class="tab-add" aria-label="Open a new illustrative query">' + icons('plus') + '</button>';
  const selected = $(`[data-query="${state.selected}"]`);
  selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('#query-panel').setAttribute('aria-labelledby', `query-${state.selected}`);
}

function renderQuery() {
  const tab = state.tabs.find(tab => tab.id === state.selected);
  $('#sql-query').innerHTML = highlight(tab.sql);
  renderRows();
}

function renderRows() {
  const tab = state.tabs.find(tab => tab.id === state.selected);
  const rows = [...tab.rows];
  if (state.sort) rows.sort((a, b) => {
    const x = a[state.sort.column], y = b[state.sort.column];
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * state.sort.direction;
  });
  $('#results-table thead').innerHTML = '<tr>' + tab.headers.map((header, i) => `<th scope="col"${state.sort?.column === i ? ` aria-sort="${state.sort.direction > 0 ? 'ascending' : 'descending'}"` : ''}><button data-sort="${i}">${escapeHtml(header)}${state.sort?.column === i ? icons('chevron', `tiny ${state.sort.direction > 0 ? 'sort-up' : 'sort-down'}`) : ''}</button></th>`).join('') + '</tr>';
  $('#results-table tbody').innerHTML = rows.map(row => '<tr>' + row.map((value, i) => `<td${typeof value === 'number' && i > 0 ? ' class="number"' : ''}>${typeof value === 'number' && i > 0 ? value.toLocaleString('en-US', { minimumFractionDigits: /revenue|spend|price/i.test(tab.headers[i]) ? 2 : 0, maximumFractionDigits: 2 }) : escapeHtml(value)}</td>`).join('') + '</tr>').join('');
  $('#result-count').textContent = `${rows.length} rows`;
}

function selectQuery(id, announce = true) {
  state.selected = id;
  state.sort = null;
  renderTabs();
  renderQuery();
  if (announce) status(`${state.tabs.find(tab => tab.id === id).label} selected. Illustrative results updated.`);
}

function selectEngine(engine) {
  state.engine = engine;
  state.sort = null;
  const example = examples[engine];
  document.querySelectorAll('.engine-tab').forEach(button => {
    const active = button.dataset.engine === engine;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  $('#workspace-panel').setAttribute('aria-labelledby', `engine-${engine}`);
  for (const [id, value] of Object.entries({ 'connection-label': example.label, 'connection-host': example.host, 'connection-db': example.database, 'connection-schema': example.schema, 'tree-host': example.host, 'tree-db': example.database, 'tree-schema': example.schema, 'extra-folder': example.folder, 'secondary-db': example.secondary, 'agent-message': example.message, 'agent-query-label': `${example.queryName} (agent)` })) $('#' + id).textContent = value;
  $('#object-search').value = '';
  seedTabs();
  renderObjects();
  selectQuery('agent', false);
  status(`${example.label} illustrative workspace loaded. No live database is connected.`);
}

function openNewQuery() {
  const id = `new-${++state.queryCounter}`;
  const example = examples[state.engine];
  state.tabs.push({ id, label: `Query ${state.queryCounter}`, sql: example.tableQuery(example.tables[0]), headers: example.headers, rows: example.rows });
  state.selected = id;
  state.sort = null;
  renderTabs(id);
  renderQuery();
  status('New illustrative query tab opened.');
}

function closeQuery(id) {
  if (state.tabs.length <= 1) { status('Keep at least one illustrative query tab open.'); return; }
  const index = state.tabs.findIndex(tab => tab.id === id);
  const label = state.tabs[index].label;
  state.tabs.splice(index, 1);
  if (state.selected === id) state.selected = state.tabs[Math.min(index, state.tabs.length - 1)].id;
  state.sort = null;
  renderTabs();
  renderQuery();
  $(`[data-query="${state.selected}"]`).focus();
  status(`Closed ${label}.`);
}

async function askCapi() {
  if (state.busy) return;
  state.busy = true;
  const button = $('#ask-capi');
  const engine = state.engine;
  button.disabled = true;
  $('#agent-message').textContent = 'I’m opening a new query tab based on your current work.';
  $('.agent-panel').classList.add('is-working');
  $('.proof-demo').classList.add('responding');
  await new Promise(resolve => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 550));
  if (state.engine === engine) {
    const id = `capi-${++state.queryCounter}`;
    const isLance = engine === 'lance';
    const label = isLance ? 'Products by category (agent)' : 'Customers by region (agent)';
    state.tabs.push({ id, label, sql: examples[engine].regionSql, headers: isLance ? ['category', 'products'] : ['Region', 'Customers'], rows: isLance ? [['Outdoor', 42], ['Clothing', 31], ['Accessories', 24], ['Home', 18]] : regionRows });
    state.selected = id;
    state.sort = null;
    renderTabs(id);
    renderQuery();
    $('#agent-message').textContent = `I opened ${isLance ? 'products by category' : 'customers by region'} in a new query tab. The results are in your grid.`;
    $('#agent-query-label').textContent = label;
    status(`Capi opened ${label} in a new tab with four illustrative result rows. No live query was executed.`);
  }
  button.disabled = false;
  state.busy = false;
  $('.agent-panel').classList.remove('is-working');
  setTimeout(() => $('.proof-demo').classList.remove('responding'), 700);
}

document.querySelectorAll('.engine-tab').forEach(button => button.addEventListener('click', () => selectEngine(button.dataset.engine)));
$('.engine-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const buttons = [...document.querySelectorAll('.engine-tab')];
  let index = buttons.findIndex(button => button.getAttribute('aria-selected') === 'true');
  index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  selectEngine(buttons[index].dataset.engine);
  buttons[index].focus();
});
$('#query-tabs').addEventListener('click', event => {
  const close = event.target.closest('[data-close]');
  if (close) { closeQuery(close.dataset.close); return; }
  const tab = event.target.closest('[data-query]');
  if (tab) selectQuery(tab.dataset.query);
  else if (event.target.closest('.tab-add')) openNewQuery();
});
$('#query-tabs').addEventListener('keydown', event => {
  if (event.key === 'Delete' && event.target.matches('[data-query]')) { event.preventDefault(); closeQuery(event.target.dataset.query); return; }
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = state.tabs.findIndex(tab => tab.id === state.selected);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? state.tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + state.tabs.length) % state.tabs.length;
  selectQuery(state.tabs[next].id);
  $(`[data-query="${state.selected}"]`).focus();
});
$('#new-query').addEventListener('click', openNewQuery);
$('#ask-capi').addEventListener('click', askCapi);
$('#proof-action').addEventListener('click', () => { askCapi(); $('#workbench').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' }); });
$('#object-search').addEventListener('input', renderObjects);
$('#table-objects').addEventListener('click', event => {
  const button = event.target.closest('[data-table]');
  if (!button) return;
  const name = button.dataset.table;
  const id = `table-${++state.queryCounter}`;
  const example = examples[state.engine];
  state.tabs.push({ id, label: name, sql: example.tableQuery(name), headers: ['Table', 'Preview'], rows: [[name, 'Illustrative table selected']] });
  selectQuery(id);
});
$('#results-table').addEventListener('click', event => {
  const button = event.target.closest('[data-sort]');
  if (!button) return;
  const column = Number(button.dataset.sort);
  state.sort = { column, direction: state.sort?.column === column ? -state.sort.direction : 1 };
  renderRows();
  $('#results-table').querySelector(`[data-sort="${column}"]`).focus();
  status('Illustrative result rows sorted.');
});
$('#run-query').addEventListener('click', () => { renderQuery(); status('Illustrative query completed. Results refreshed locally; no live database is connected.'); $('#result-count').textContent += ' · refreshed'; });
$('#export-results').addEventListener('click', () => {
  const tab = state.tabs.find(tab => tab.id === state.selected);
  const csv = [tab.headers, ...tab.rows].map(row => row.map(value => '"' + String(value).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = 'based-illustrative-results.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('Illustrative results exported as CSV.');
});

selectEngine('mssql');

// The release page remains a working fallback if GitHub's public API is unavailable.
fetch('https://api.github.com/repos/Cyronius/based/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(6000) })
  .then(response => response.ok ? response.json() : null)
  .then(release => {
    if (!release?.assets) return;
    for (const [selector, pattern] of [['.download-windows', /-Setup\.exe$/i], ['.download-macos', /macos-arm64\.dmg$/i]]) {
      const asset = release.assets.find(asset => pattern.test(asset.name));
      if (!asset || !asset.browser_download_url.startsWith('https://github.com/Cyronius/based/releases/download/')) continue;
      document.querySelectorAll(selector).forEach(link => { link.href = asset.browser_download_url; });
    }
  }).catch(() => {});
