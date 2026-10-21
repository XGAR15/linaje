/**
 * Linaje - Aplicación Principal
 * Coordinador de UI, eventos de carga, gestión de proyectos y filtros
 */

document.addEventListener('DOMContentLoaded', () => {
  // Inicialización de componentes principales
  const parser = new QlikLineageParser();
  const graphContainer = document.getElementById('graph-container');
  let graph = null;

  // Elementos de la UI
  const fileFolderInput = document.getElementById('file-folder-input');
  const fileZipInput = document.getElementById('file-zip-input');
  const fileProjectInput = document.getElementById('file-project-input');
  const dropOverlay = document.getElementById('drop-overlay');
  const emptyState = document.getElementById('empty-state');
  const inspectorPanel = document.getElementById('inspector-panel');

  // Inicializar el Grafo
  graph = new ObsidianGraph(graphContainer, (selectedNode) => {
    updateInspector(selectedNode);
  });

  // Notificaciones Toast
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== window.location.origin ||
        message?.source !== 'qlik-lineage-chrome-extension' ||
        message.type !== 'IMPORT_QLIK_SCRIPT') return;

    const appName = typeof message.appName === 'string' ? message.appName.trim() : '';
    const script = typeof message.script === 'string' ? message.script : '';
    if (!appName || !script.trim()) {
      showToast('No se recibió el nombre o el script de la app Qlik.');
      return;
    }

    parser.parseAppScript(appName, script);
    updateUI();
    showToast(`App Qlik "${appName}" importada desde Chrome.`);
  });

  // Los CSV de cadenas QMC y de entradas/salidas traen cientos de apps: se arranca sin apps
  // seleccionadas y el usuario marca las que quiere ver en la lista lateral
  const isBulkCsvApp = node => node.nodeRole === 'APP' &&
    (node.dataSource === 'qmc-chain-csv' || node.dataSource === 'qlik-io-csv');

  // Actualizar la interfaz tras procesar o cargar datos
  function updateUI() {
    const graphData = parser.buildGraph();
    const { nodes, links, stats } = graphData;
    if (nodes.some(isBulkCsvApp) && graph.selectedAppIds === null) {
      graph.selectedAppIds = new Set();
    }

    // Actualizar Estadísticas
    document.getElementById('stat-apps').textContent = stats.totalApps;
    document.getElementById('stat-datasets').textContent = stats.totalDatasets;
    document.getElementById('stat-stg').textContent = stats.totalStg;
    document.getElementById('stat-data').textContent = stats.totalData;
    document.getElementById('stat-links').textContent = stats.totalLinks;
    document.getElementById('stat-unconsumed').textContent = stats.unconsumedCount;
    document.getElementById('stat-fields').textContent = stats.totalFields || 0;

    // Contadores en los chips
    document.getElementById('count-chip-app').textContent = stats.totalApps;
    document.getElementById('count-chip-stg').textContent = stats.totalStg;
    document.getElementById('count-chip-data').textContent = stats.totalData;
    document.getElementById('count-chip-other').textContent = stats.totalOther;
    rebuildAppChecklist(nodes);

    // Reconstruir el panel de campos
    rebuildFieldsList();

    // Mostrar u ocultar estado vacío
    if (nodes.length > 0) {
      graph.setData(nodes, links);
      updateEmptyState();
      showToast(`⚡ Grafo generado: ${nodes.length} nodos y ${links.length} dependencias.`);
    } else {
      emptyState.style.display = 'flex';
    }
  }

  function updateEmptyState() {
    const hasBulkCsv = graph.rawNodes?.some(isBulkCsvApp);
    const hasVisibleNodes = graph.nodes.length > 0;
    emptyState.style.display = hasVisibleNodes ? 'none' : 'flex';
    if (!hasBulkCsv) return;

    emptyState.querySelector('h2').textContent = 'Selecciona una app para ver sus dependencias';
    emptyState.querySelector('p').textContent = 'Busca una app en la lista lateral y márcala para ver el STG, DATA y la cadena que la alimentan.';
    emptyState.querySelector('.empty-state-actions').style.display = 'none';
  }

  function rebuildAppChecklist(nodes) {
    const list = document.getElementById('app-checklist');
    const count = document.getElementById('app-filter-count');
    const allApps = nodes.filter(node => node.nodeRole === 'APP')
      .sort((left, right) => left.name.localeCompare(right.name, 'es'));
    const query = document.getElementById('app-filter-search').value.trim().toLocaleLowerCase();
    const apps = query ? allApps.filter(app => app.name.toLocaleLowerCase().includes(query)) : allApps;

    list.innerHTML = '';
    if (allApps.length === 0) {
      list.innerHTML = '<p class="empty-text">No hay apps cargadas.</p>';
      count.textContent = '0';
      return;
    }

    const selected = graph.selectedAppIds;
    const selectedCount = selected === null ? allApps.length : allApps.filter(app => selected.has(app.id)).length;
    count.textContent = selected === null ? `Todas (${allApps.length})` : `${selectedCount} / ${allApps.length}`;
    if (apps.length === 0) {
      list.innerHTML = '<p class="empty-text">No hay apps que coincidan.</p>';
      return;
    }

    for (const app of apps) {
      const label = document.createElement('label');
      label.className = 'app-check-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected === null || selected.has(app.id);
      checkbox.addEventListener('change', () => {
        const nextSelected = selected === null
          ? new Set(allApps.map(item => item.id))
          : new Set(selected);
        if (checkbox.checked) nextSelected.add(app.id);
        else nextSelected.delete(app.id);
        graph.setSelectedApps(nextSelected);
        updateEmptyState();
        rebuildAppChecklist(nodes);
      });

      const name = document.createElement('span');
      name.textContent = app.name;
      name.title = app.name;
      label.append(checkbox, name);
      list.appendChild(label);
    }
  }

  document.getElementById('app-filter-search').addEventListener('input', () => {
    rebuildAppChecklist(graph.rawNodes || []);
  });

  // =========================================================================
  // Panel de Campos (Column-Level Lineage)
  // =========================================================================

  function rebuildFieldsList(filterQuery = '') {
    const list = document.getElementById('fields-list');
    const allFields = parser.getAllFields();
    const q = (filterQuery || '').toLowerCase().trim();

    const filtered = q ? allFields.filter(f => f.name.toLowerCase().includes(q)) : allFields;

    list.innerHTML = '';
    if (filtered.length === 0) {
      list.innerHTML = '<p class="empty-text" style="padding: 8px 0;">Ningún campo encontrado.</p>';
      return;
    }

    for (const f of filtered.slice(0, 300)) {
      const el = document.createElement('div');
      el.className = 'lineage-item';
      el.style.fontSize = '0.78rem';
      el.style.padding = '5px 10px';

      const isTracked = graph.trackedFieldName && graph.trackedFieldName.toLowerCase() === f.key;
      if (isTracked) {
        el.style.border = '1px solid rgba(251,191,36,0.5)';
        el.style.background = 'rgba(251,191,36,0.08)';
      }

      el.innerHTML = `
        <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${f.name}">🔬 ${f.name}</span>
        <span style="color:${f.occurrences > 1 ? '#fbbf24' : 'var(--text-dim)'}; font-size:0.7rem; flex-shrink:0; margin-left:6px;">
          ${f.occurrences > 1 ? '🔗' : ''} ${f.occurrences} nodo${f.occurrences !== 1 ? 's' : ''}
        </span>
      `;

      el.addEventListener('click', () => {
        trackField(f.key);
        rebuildFieldsList(filterQuery);
      });

      list.appendChild(el);
    }

    if (filtered.length > 300) {
      const more = document.createElement('p');
      more.className = 'empty-text';
      more.style.padding = '4px 0';
      more.textContent = `... y ${filtered.length - 300} campos más. Usa el buscador para filtrar.`;
      list.appendChild(more);
    }
  }

  function trackField(fieldKey) {
    const journey = parser.getFieldJourney(fieldKey);
    if (!journey) {
      showToast('Este campo no se encontró en el árbol de linaje.');
      return;
    }

    const nodeIds = Array.from(journey.nodeIds);
    graph.trackField(journey.name, nodeIds);

    // Actualizar banner
    const banner = document.getElementById('field-tracking-banner');
    const nameLbl = document.getElementById('field-tracking-name');
    const infoLbl = document.getElementById('field-tracking-info');
    banner.style.display = 'block';
    nameLbl.textContent = journey.name;
    infoLbl.textContent = `Aparece en ${nodeIds.length} nodo(s): ${nodeIds.map(id => id.replace(/^(app:|ds:)/, '')).slice(0, 6).join(', ')}${nodeIds.length > 6 ? '...' : ''}`;

    // Cambiar a tab de campos si no está activo
    activateTab('fields');
    showToast(`🔬 Trazando campo: "${journey.name}" — ${nodeIds.length} nodo(s) resaltados.`);
  }

  // Buscador del panel de campos
  const fieldSearchInput = document.getElementById('field-search-input');
  fieldSearchInput.addEventListener('input', (e) => {
    rebuildFieldsList(e.target.value);
  });

  document.getElementById('btn-clear-field-tracking').addEventListener('click', () => {
    graph.clearFieldTracking();
    document.getElementById('field-tracking-banner').style.display = 'none';
    rebuildFieldsList(fieldSearchInput.value);
    showToast('Rastreo de campo limpiado.');
  });

  // Filtro en vivo del panel de campos en el inspector
  const inspectorFieldFilter = document.getElementById('inspector-field-filter');
  inspectorFieldFilter.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#inspector-fields-list .field-item').forEach(el => {
      el.style.display = el.dataset.fieldname.includes(q) ? '' : 'none';
    });
  });

  // =========================================================================
  // Panel de Inspección (Linaje Upstream & Downstream)
  // =========================================================================
  function updateInspector(node) {
    if (!node) {
      inspectorPanel.classList.remove('open');
      return;
    }

    inspectorPanel.classList.add('open');

    // Título y Tipo
    document.getElementById('inspector-node-name').textContent = node.name;
    const badge = document.getElementById('inspector-node-badge');
    badge.textContent = node.type;
    badge.className = `node-type-badge badge-${node.type.toLowerCase()}`;

    const upstreamList = document.getElementById('inspector-upstream-list');
    const downstreamList = document.getElementById('inspector-downstream-list');
    const impactBox = document.getElementById('inspector-impact-box');
    const scriptBox = document.getElementById('inspector-script-box');

    upstreamList.innerHTML = '';
    downstreamList.innerHTML = '';

    if (node.nodeRole === 'APP' || node.type === 'APP') {
      // Para una APP:
      // Upstream = Datasets que lee (Inputs)
      if (node.inputs && node.inputs.length > 0) {
        node.inputs.forEach(inputName => {
          const item = createLineageItem(inputName, 'in', () => {
            graph.zoomToNode(`ds:${inputName.toUpperCase()}`);
          });
          upstreamList.appendChild(item);
        });
      } else {
        if (!node.upstreamApps?.length) {
          upstreamList.innerHTML = '<span class="empty-text">No lee ningún dataset externo detectado.</span>';
        }
      }
      if (node.upstreamApps?.length) {
        node.upstreamApps.forEach(appName => {
          const item = createLineageItem(appName, 'app', () => graph.zoomToNode(`app:${appName}`));
          upstreamList.appendChild(item);
        });
      }

      // Downstream = Datasets que genera (Outputs)
      if (node.outputs && node.outputs.length > 0) {
        node.outputs.forEach(outputName => {
          const item = createLineageItem(outputName, 'out', () => {
            graph.zoomToNode(`ds:${outputName.toUpperCase()}`);
          });
          downstreamList.appendChild(item);
        });
      } else {
        if (!node.downstreamApps?.length) {
          downstreamList.innerHTML = '<span class="empty-text">No genera ningún dataset (STORE) detectado.</span>';
        }
      }
      if (node.downstreamApps?.length) {
        node.downstreamApps.forEach(appName => {
          const item = createLineageItem(appName, 'app', () => graph.zoomToNode(`app:${appName}`));
          downstreamList.appendChild(item);
        });
      }

      // Análisis de Impacto
      impactBox.innerHTML = `<strong>Aplicación Qlik:</strong> Procesa <strong>${(node.inputs?.length || 0) + (node.upstreamApps?.length || 0)}</strong> dependencias y alimenta <strong>${(node.outputs?.length || 0) + (node.downstreamApps?.length || 0)}</strong> recursos/apps.`;

      // Snippet del Script
      scriptBox.textContent = node.snippet || 'No hay vista previa de script disponible.';

      // Botón de exportar JSON: solo si hay script completo capturado
      const exportBtn = document.getElementById('btn-export-node-script');
      if (node.fullScript && node.fullScript.trim()) {
        exportBtn.style.display = '';
        exportBtn.dataset.appName = node.name;
      } else {
        exportBtn.style.display = 'none';
        delete exportBtn.dataset.appName;
      }
    } else {
      document.getElementById('btn-export-node-script').style.display = 'none';
      // Para un DATASET (STG, DATA, FUENTE, etc.)
      // Upstream = Aplicaciones que lo producen (Producers)
      if (node.producers && node.producers.length > 0) {
        node.producers.forEach(appName => {
          const item = createLineageItem(appName, 'app', () => {
            graph.zoomToNode(`app:${appName}`);
          });
          upstreamList.appendChild(item);
        });
      } else {
        upstreamList.innerHTML = '<span class="empty-text">⚠️ No hay una app productora en los datos cargados. Si este recurso lo genera una app Qlik, carga también su CSV o script.</span>';
      }

      // Downstream = Aplicaciones que lo consumen (Consumers)
      if (node.consumers && node.consumers.length > 0) {
        node.consumers.forEach(appName => {
          const item = createLineageItem(appName, 'app', () => {
            graph.zoomToNode(`app:${appName}`);
          });
          downstreamList.appendChild(item);
        });
      } else {
        downstreamList.innerHTML = '<span class="empty-text">⚠️ No hay una app consumidora de este recurso en los datos cargados.</span>';
      }

      // Análisis de Impacto
      const consumersCount = node.consumers ? node.consumers.length : 0;
      if (consumersCount > 0) {
        impactBox.innerHTML = `⚠️ <strong>Impacto directo:</strong> Si este recurso cambia, se verán afectadas <strong>${consumersCount} aplicación(es)</strong> consumidoras.`;
      } else {
        impactBox.innerHTML = `ℹ️ <strong>Sin consumidores:</strong> Posible archivo obsoleto o de uso ad-hoc.`;
      }

      scriptBox.textContent = `Nombre: ${node.name}\nTipo: ${node.type}\nProductores: ${node.producers ? node.producers.join(', ') : 'Ninguno'}\nConsumidores: ${node.consumers ? node.consumers.join(', ') : 'Ninguno'}`;
    }

    // Mostrar campos del nodo en el inspector
    const fieldsSection = document.getElementById('inspector-fields-section');
    const fieldsList = document.getElementById('inspector-fields-list');
    const fieldsCount = document.getElementById('inspector-fields-count');
    const nodeFields = node.fields || [];
    fieldsSection.style.display = nodeFields.length > 0 ? 'flex' : 'none';
    fieldsCount.textContent = `(${nodeFields.length})`;
    fieldsList.innerHTML = '';
    document.getElementById('inspector-field-filter').value = '';

    nodeFields.slice(0, 250).forEach(f => {
      const el = document.createElement('div');
      el.className = 'lineage-item field-item';
      el.dataset.fieldname = f.name.toLowerCase();
      el.style.cssText = 'padding: 4px 10px; font-size: 0.78rem; cursor: pointer;';

      const inJourney = parser.getFieldJourney(f.name.toLowerCase());
      const occurrences = inJourney ? inJourney.nodeIds.size : 1;
      const isTracked = graph.trackedFieldName && graph.trackedFieldName.toLowerCase() === f.name.toLowerCase();

      if (isTracked) {
        el.style.border = '1px solid rgba(251,191,36,0.5)';
        el.style.background = 'rgba(251,191,36,0.08)';
      }

      el.innerHTML = `
        <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${f.name}">
          ${isTracked ? '🟡' : '🔬'} ${f.name}${f.hasAlias ? ` <span style="color:var(--text-dim); font-size:0.7rem;">AS ${f.name}</span>` : ''}
        </span>
        <span style="color:${occurrences > 1 ? '#fbbf24' : 'var(--text-dim)'}; font-size:0.7rem; flex-shrink:0; margin-left:6px;">
          ${occurrences > 1 ? `🔗 ${occurrences}` : ''}
        </span>
      `;

      el.title = `Clic para trazar "${f.name}" en todos los nodos`;
      el.addEventListener('click', () => {
        trackField(f.name.toLowerCase());
        // Re-render list to show tracking state
        nodeFields.slice(0, 250).forEach((ff, idx) => {
          const items = fieldsList.querySelectorAll('.field-item');
          if (items[idx]) {
            const isTr = graph.trackedFieldName && graph.trackedFieldName.toLowerCase() === ff.name.toLowerCase();
            items[idx].style.border = isTr ? '1px solid rgba(251,191,36,0.5)' : '';
            items[idx].style.background = isTr ? 'rgba(251,191,36,0.08)' : '';
          }
        });
      });

      fieldsList.appendChild(el);
    });
    if (nodeFields.length > 250) {
      const p = document.createElement('p');
      p.className = 'empty-text';
      p.textContent = `... y ${nodeFields.length - 250} campos más.`;
      fieldsList.appendChild(p);
    }
  }

  function createLineageItem(name, role, onClick) {
    const el = document.createElement('div');
    el.className = 'lineage-item';
    let icon = '📁';
    if (role === 'app') icon = '📱';
    if (role === 'in') icon = '📥';
    if (role === 'out') icon = '📤';

    el.innerHTML = `
      <span>${icon} ${name}</span>
      <span style="color: var(--color-app); font-size: 0.75rem;">Ver ➜</span>
    `;
    el.addEventListener('click', onClick);
    return el;
  }

  // Cerrar panel de inspección
  document.getElementById('btn-close-inspector').addEventListener('click', () => {
    graph.selectNode(null);
  });

  // =========================================================================
  // Ingesta de Archivos: Carpetas y ZIPs
  // =========================================================================
  document.getElementById('btn-upload-folder').addEventListener('click', () => fileFolderInput.click());
  document.getElementById('btn-upload-zip').addEventListener('click', () => fileZipInput.click());
  document.getElementById('empty-btn-folder').addEventListener('click', () => fileFolderInput.click());
  document.getElementById('empty-btn-zip').addEventListener('click', () => fileZipInput.click());

  // Carga de Carpeta
  fileFolderInput.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    showToast("Analizando archivos de la carpeta...", "info");
    try {
      const count = await parser.processFileList(files);
      updateUI();
      showToast(`Se procesaron ${count} archivos de script exitosamente.`);
    } catch (err) {
      alert(`Error al procesar la carpeta: ${err.message}`);
    }
  });

  // Carga de ZIPs, CSV de modelo Qlik o scripts individuales
  fileZipInput.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    showToast("Procesando archivos ZIP / Scripts...", "info");
    try {
      let totalLoaded = 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.zip')) {
          totalLoaded += await parser.processZipFile(file);
        } else if (lower.endsWith('.csv')) {
          totalLoaded += parser.processQlikCsv(await file.text(), file.name.replace(/\.[^/.]+$/, ''));
        } else if (lower.endsWith('.qvf')) {
          const extractedText = await parser.extractScriptFromQvfFile(file);
          parser.parseAppScript(file.name.replace(/\.[^/.]+$/, ''), extractedText);
          totalLoaded++;
        } else if (lower.endsWith('.json')) {
          const text = await file.text();
          parser.processLoadscriptJson(file.name.replace(/\.[^/.]+$/, ''), text);
          totalLoaded++;
        } else {
          const text = await file.text();
          parser.parseAppScript(file.name.replace(/\.[^/.]+$/, ''), text);
          totalLoaded++;
        }
      }
      updateUI();
      showToast(`Procesados ${totalLoaded} recursos de los archivos.`);
    } catch (err) {
      alert(`Error procesando ZIP: ${err.message}`);
    }
  });

  // =========================================================================
  // Drag and Drop en toda la ventana
  // =========================================================================
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropOverlay.classList.add('active');
  });

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) {
      dropOverlay.classList.remove('active');
    }
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropOverlay.classList.remove('active');

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    // Verificar si es un archivo de proyecto (.linaje o .json)
    if (files.length === 1 && files[0].name.toLowerCase().endsWith('.linaje')) {
      loadProjectFile(files[0]);
      return;
    }

    showToast("Procesando archivos arrastrados...", "info");
    try {
      let count = 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.zip')) {
          count += await parser.processZipFile(file);
        } else if (lower.endsWith('.csv')) {
          count += parser.processQlikCsv(await file.text(), file.name.replace(/\.[^/.]+$/, ''));
        } else if (lower.endsWith('.qvf')) {
          const extractedText = await parser.extractScriptFromQvfFile(file);
          parser.parseAppScript(file.name.replace(/\.[^/.]+$/, ''), extractedText);
          count++;
        } else if (lower.endsWith('.linaje') || (lower.endsWith('.json') && !lower.includes('loadscript'))) {
          // Posible proyecto
          loadProjectFile(file);
          return;
        } else if (lower.endsWith('.json')) {
          const text = await file.text();
          parser.processLoadscriptJson(file.name.replace(/\.[^/.]+$/, ''), text);
          count++;
        } else {
          const text = await file.text();
          parser.parseAppScript(file.name.replace(/\.[^/.]+$/, ''), text);
          count++;
        }
      }
      updateUI();
      showToast(`Se cargaron ${count} recursos.`);
    } catch (err) {
      alert(`Error al procesar: ${err.message}`);
    }
  });

  // =========================================================================
  // Gestión de Proyectos (Exportar / Importar)
  // =========================================================================
  document.getElementById('btn-export-project').addEventListener('click', () => {
    const projectNameInput = document.getElementById('project-name-input');
    const name = projectNameInput.value.trim() || 'Proyecto_Linaje';
    const project = parser.exportProject(name);

    const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0,10)}.linaje`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("💾 Proyecto exportado exitosamente.");
  });

  document.getElementById('btn-export-selection').addEventListener('click', () => {
    const selectedIds = graph.selectedNodeIds;
    const selectedNodes = graph.nodes.filter(node => selectedIds.has(node.id));
    if (selectedNodes.length === 0) {
      showToast('Selecciona uno o más nodos del diagrama antes de exportar.', 'error');
      return;
    }

    const selectedIdSet = new Set(selectedNodes.map(node => node.id));
    const runtimeNodeKeys = new Set([
      'x', 'y', 'vx', 'vy', 'fx', 'fy', 'targetX', 'index', 'rank', 'isSource', 'isTerminal'
    ]);
    const nodes = selectedNodes.map(node => Object.fromEntries(
      Object.entries(node).filter(([key]) => !runtimeNodeKeys.has(key))
    ));
    const links = graph.rawLinks
      .filter(link => selectedIdSet.has(
        typeof link.source === 'object' ? link.source.id : link.source
      ) && selectedIdSet.has(
        typeof link.target === 'object' ? link.target.id : link.target
      ))
      .map(link => ({
        ...link,
        source: typeof link.source === 'object' ? link.source.id : link.source,
        target: typeof link.target === 'object' ? link.target.id : link.target
      }));
    const projectName = document.getElementById('project-name-input').value.trim() || 'Proyecto_Linaje';
    const payload = {
      projectName,
      exportedAt: new Date().toISOString(),
      nodes,
      links
    };
    const fileName = `${safeFileName(projectName)}_seleccion_nodos.json`;
    downloadFile(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), fileName);
    showToast(`📤 Se exportaron ${nodes.length} nodos y ${links.length} enlaces como JSON.`);
  });

  document.getElementById('btn-import-project').addEventListener('click', () => fileProjectInput.click());

  // Exportar el script completo de una app (nodo APP del grafo) como JSON
  document.getElementById('btn-export-node-script').addEventListener('click', (e) => {
    const appName = e.currentTarget.dataset.appName;
    const app = appName ? parser.apps.get(appName) : null;
    if (!app || !app.fullScript) {
      showToast("No hay script completo disponible para exportar.", "error");
      return;
    }

    const payload = {
      appName,
      script: app.fullScript,
      exportedAt: new Date().toISOString()
    };
    const safeName = appName.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'app';
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.loadscript.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`📜 Script de "${appName}" exportado como JSON.`);
  });

  fileProjectInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      loadProjectFile(e.target.files[0]);
    }
  });

  async function loadProjectFile(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      parser.importProject(data);
      if (data.projectName) {
        document.getElementById('project-name-input').value = data.projectName;
      }
      updateUI();
      showToast(`📂 Proyecto "${data.projectName || file.name}" restaurado.`);
    } catch (err) {
      alert(`Error al cargar el proyecto: ${err.message}`);
    }
  }

  // =========================================================================
  // Dataset Demo (Para probar al instante con 1 clic)
  // =========================================================================
  const loadDemoBtn = document.getElementById('btn-load-demo');
  const emptyDemoBtn = document.getElementById('empty-btn-demo');

  const runDemo = () => {
    parser.reset();

    // App 1: Ingesta de Ventas desde SAP y Salesforce
    parser.parseAppScript("01_Ingesta_Ventas", `
      // Extracción desde fuente externa
      Ventas_Raw:
      LOAD * FROM [lib://SAP_CONN/VBAK_VBRK.qvd] (qvd);
      
      STORE Ventas_Raw INTO [lib://QVD_STG/STG_VENTAS_CABECERA.QVD] (qvd);

      Detalle_Raw:
      LOAD * FROM [lib://SALESFORCE_CONN/OpportunityLineItem.csv] (txt);

      STORE Detalle_Raw INTO [lib://QVD_STG/STG_VENTAS_DETALLE.QVD] (qvd);
    `);

    // App 2: Ingesta de Clientes y Maestros
    parser.parseAppScript("02_Ingesta_Maestros", `
      Clientes:
      LOAD * FROM [lib://CRM_DB/CLIENTES.parquet];

      STORE Clientes INTO [lib://QVD_STG/STG_CLIENTES.QVD] (qvd);

      Productos:
      LOAD * FROM [lib://ERP/MARA.qvd];

      STORE Productos INTO [lib://QVD_STG/STG_PRODUCTOS.QVD] (qvd);
    `);

    // App 3: Transformación Data Mart Comercial
    parser.parseAppScript("03_Transformacion_Comercial", `
      Ventas:
      LOAD * FROM [lib://QVD_STG/STG_VENTAS_CABECERA.QVD] (qvd);
      
      Detalles:
      LOAD * FROM [lib://QVD_STG/STG_VENTAS_DETALLE.QVD] (qvd);

      Clientes:
      LOAD * FROM [lib://QVD_STG/STG_CLIENTES.QVD] (qvd);

      // Consolidación y publicación de DATAs
      STORE Ventas INTO [lib://QVD_DATA/DATA_VENTAS_CONSOLIDADO.QVD] (qvd);
      STORE Clientes INTO [lib://QVD_DATA/DATA_DIM_CLIENTES.QVD] (qvd);
    `);

    // App 4: Transformación Finanzas
    parser.parseAppScript("04_Transformacion_Finanzas", `
      VentasData:
      LOAD * FROM [lib://QVD_DATA/DATA_VENTAS_CONSOLIDADO.QVD] (qvd);

      STORE Facturacion INTO [lib://QVD_DATA/DATA_FACTURACION_MENSUAL.QVD] (qvd);
    `);

    // App 5: Tablero Ejecutivo Dirección
    parser.parseAppScript("05_Tablero_Ejecutivo_BI", `
      LOAD * FROM [lib://QVD_DATA/DATA_VENTAS_CONSOLIDADO.QVD] (qvd);
      LOAD * FROM [lib://QVD_DATA/DATA_DIM_CLIENTES.QVD] (qvd);
      LOAD * FROM [lib://QVD_DATA/DATA_FACTURACION_MENSUAL.QVD] (qvd);
    `);

    // App 6: Tablero de Operaciones y Logística
    parser.parseAppScript("06_App_Operaciones_Logistica", `
      LOAD * FROM [lib://QVD_STG/STG_PRODUCTOS.QVD] (qvd);
      LOAD * FROM [lib://QVD_DATA/DATA_VENTAS_CONSOLIDADO.QVD] (qvd);
    `);

    document.getElementById('project-name-input').value = 'Ecosistema Qlik Demo';
    updateUI();
    showToast("🚀 Ecosistema de prueba cargado con éxito.");
  };

  loadDemoBtn.addEventListener('click', runDemo);
  emptyDemoBtn.addEventListener('click', runDemo);

  // =========================================================================
  // Filtros y Búsqueda
  // =========================================================================
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', (e) => {
    graph.filters.searchQuery = e.target.value.trim();
    graph.updateGraphData();
  });

  const nodeSearchInput = document.getElementById('node-search-input');
  const nodeSearchResults = document.getElementById('node-search-results');
  const maxNodeSearchResults = 8;

  function closeNodeSearchResults() {
    nodeSearchResults.hidden = true;
    nodeSearchInput.setAttribute('aria-expanded', 'false');
    nodeSearchInput.removeAttribute('aria-activedescendant');
  }

  function focusSearchedNode(node) {
    graph.zoomToNode(node.id);
    nodeSearchInput.value = node.name;
    closeNodeSearchResults();
  }

  function renderNodeSearchResults() {
    const query = nodeSearchInput.value.trim().toLocaleLowerCase();
    nodeSearchResults.replaceChildren();
    nodeSearchInput.removeAttribute('aria-activedescendant');
    if (!query) {
      closeNodeSearchResults();
      return;
    }

    const matches = graph.nodes
      .filter(node => String(node.name || '').toLocaleLowerCase().includes(query))
      .sort((left, right) => {
        const leftName = String(left.name || '').toLocaleLowerCase();
        const rightName = String(right.name || '').toLocaleLowerCase();
        const leftIndex = leftName.indexOf(query);
        const rightIndex = rightName.indexOf(query);
        return leftIndex - rightIndex || leftName.localeCompare(rightName, 'es');
      });

    nodeSearchResults.hidden = false;
    nodeSearchInput.setAttribute('aria-expanded', 'true');
    if (matches.length === 0) {
      const message = document.createElement('div');
      message.className = 'node-search-message';
      message.textContent = 'No se encontraron nodos visibles.';
      nodeSearchResults.appendChild(message);
      return;
    }

    matches.slice(0, maxNodeSearchResults).forEach((node, index) => {
      const result = document.createElement('button');
      result.type = 'button';
      result.className = 'node-search-result';
      result.id = `node-search-result-${index}`;
      result.setAttribute('role', 'option');

      const name = document.createElement('span');
      name.className = 'node-search-result-name';
      name.textContent = node.name;
      name.title = node.name;

      const type = document.createElement('span');
      type.className = 'node-search-result-type';
      type.textContent = node.type;

      result.append(name, type);
      result.addEventListener('click', () => focusSearchedNode(node));
      nodeSearchResults.appendChild(result);
    });

    if (matches.length > maxNodeSearchResults) {
      const message = document.createElement('div');
      message.className = 'node-search-message';
      message.textContent = `Mostrando ${maxNodeSearchResults} de ${matches.length} resultados. Escribe más para acotar.`;
      nodeSearchResults.appendChild(message);
    }
  }

  nodeSearchInput.addEventListener('input', renderNodeSearchResults);
  nodeSearchInput.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closeNodeSearchResults();
      return;
    }
    if (event.key === 'Enter') {
      const firstResult = nodeSearchResults.querySelector('.node-search-result');
      if (firstResult) {
        event.preventDefault();
        firstResult.click();
      }
    }
  });

  ['APP', 'STG', 'DATA', 'OTHER'].forEach(type => {
    const chip = document.getElementById(`filter-chip-${type.toLowerCase()}`);
    if (chip) {
      chip.addEventListener('click', () => {
        const key = type === 'OTHER' ? 'FUENTE' : type;
        graph.filters[key] = !graph.filters[key];
        chip.style.opacity = graph.filters[key] ? '1' : '0.4';
        graph.updateGraphData();
      });
    }
  });

  document.getElementById('btn-apps-all').addEventListener('click', () => {
    graph.setSelectedApps(null);
    updateEmptyState();
    if (graph.rawNodes) rebuildAppChecklist(graph.rawNodes);
  });

  document.getElementById('btn-apps-none').addEventListener('click', () => {
    graph.setSelectedApps([]);
    updateEmptyState();
    if (graph.rawNodes) rebuildAppChecklist(graph.rawNodes);
  });

  const checkOrphans = document.getElementById('filter-hide-orphans');
  checkOrphans.addEventListener('change', (e) => {
    graph.filters.hideOrphans = e.target.checked;
    graph.updateGraphData();
  });

  // =========================================================================
  // Controles de Física y Disposición de Flujo
  // =========================================================================
  const sliderRepulsion = document.getElementById('slider-repulsion');
  const sliderHorizontal = document.getElementById('slider-horizontal');
  const sliderDistance = document.getElementById('slider-distance');
  const sliderGravity = document.getElementById('slider-gravity');
  const checkParticles = document.getElementById('check-particles');
  const checkLabels = document.getElementById('check-labels');
  const checkCurves = document.getElementById('check-curves');
  const btnToggleLayout = document.getElementById('btn-toggle-layout');

  btnToggleLayout.addEventListener('click', () => {
    if (graph.layoutMode === 'lr') {
      graph.setLayoutMode('radial');
      btnToggleLayout.textContent = '🌐 Modo Libre';
      btnToggleLayout.className = 'btn';
      showToast('Cambiado a Modo Radial Libre.');
    } else {
      graph.setLayoutMode('lr');
      btnToggleLayout.textContent = '➡️ Flujo Izq ➔ Der';
      btnToggleLayout.className = 'btn btn-primary';
      showToast('Cambiado a Flujo Jerárquico Izquierda a Derecha.');
    }
  });

  sliderRepulsion.addEventListener('input', (e) => {
    const val = -parseInt(e.target.value);
    graph.physics.chargeStrength = val;
    document.getElementById('val-repulsion').textContent = Math.abs(val);
    if (graph.simulation) {
      graph.simulation.force('charge', d3.forceManyBody().strength(val).distanceMax(600));
      graph.simulation.alpha(0.3).restart();
    }
  });

  sliderHorizontal.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value) / 100;
    graph.physics.horizontalStrength = val;
    document.getElementById('val-horizontal').textContent = (val * 100).toFixed(0) + '%';
    if (graph.simulation && graph.layoutMode === 'lr') {
      graph.simulation.force('x', d3.forceX(d => d.targetX).strength(val));
      graph.simulation.alpha(0.3).restart();
    }
  });

  sliderDistance.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    graph.physics.linkDistance = val;
    document.getElementById('val-distance').textContent = val;
    if (graph.simulation) {
      graph.simulation.force('link', d3.forceLink(graph.links).id(d => d.id).distance(val));
      graph.simulation.alpha(0.3).restart();
    }
  });

  sliderGravity.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value) / 100;
    graph.physics.centerStrength = val;
    document.getElementById('val-gravity').textContent = (val * 100).toFixed(0) + '%';
    if (graph.simulation && graph.layoutMode === 'radial') {
      graph.simulation.force('center', d3.forceCenter(graph.width / 2, graph.height / 2).strength(val));
      graph.simulation.alpha(0.3).restart();
    }
  });

  checkCurves.addEventListener('change', (e) => {
    graph.physics.useCurves = e.target.checked;
  });

  checkParticles.addEventListener('change', (e) => {
    graph.physics.showParticles = e.target.checked;
    graph.updateGraphData();
  });

  checkLabels.addEventListener('change', (e) => {
    graph.physics.showLabels = e.target.checked;
  });

  // Botones de Cámara flotantes
  document.getElementById('btn-reset-zoom').addEventListener('click', () => graph.resetZoom());
  document.getElementById('btn-export-img').addEventListener('click', () => graph.exportImage());

  // =========================================================================
  // Tabs de la barra lateral
  // =========================================================================
  const tabExplore = document.getElementById('tab-explore');
  const tabFields = document.getElementById('tab-fields');
  const tabPhysics = document.getElementById('tab-physics');
  const viewExplore = document.getElementById('view-explore');
  const viewFields = document.getElementById('view-fields');
  const viewPhysics = document.getElementById('view-physics');

  function activateTab(name) {
    tabExplore.classList.remove('active');
    tabFields.classList.remove('active');
    tabPhysics.classList.remove('active');
    viewExplore.style.display = 'none';
    viewFields.style.display = 'none';
    viewPhysics.style.display = 'none';

    if (name === 'explore') {
      tabExplore.classList.add('active');
      viewExplore.style.display = 'flex';
    } else if (name === 'fields') {
      tabFields.classList.add('active');
      viewFields.style.display = 'flex';
    } else if (name === 'physics') {
      tabPhysics.classList.add('active');
      viewPhysics.style.display = 'flex';
    }
  }

  tabExplore.addEventListener('click', () => activateTab('explore'));
  tabFields.addEventListener('click', () => {
    activateTab('fields');
    rebuildFieldsList(document.getElementById('field-search-input').value);
  });
  tabPhysics.addEventListener('click', () => activateTab('physics'));

  // =========================================================================
  // Modal de Matriz / Tabla de Linaje y Exportación a CSV
  // =========================================================================
  const modalTable = document.getElementById('modal-table');
  const btnOpenTable = document.getElementById('btn-open-table');
  const btnCloseTable = document.getElementById('btn-close-table');
  const tableBody = document.getElementById('matrix-table-body');
  const btnExportCsv = document.getElementById('btn-export-csv');
  const btnExportExcel = document.getElementById('btn-export-excel');
  const btnExportJson = document.getElementById('btn-export-json');
  const btnExportPpt = document.getElementById('btn-export-ppt');
  const reportExportScope = document.getElementById('report-export-scope');

  function getReportData() {
    const projectName = document.getElementById('project-name-input').value.trim() || 'Proyecto_Linaje';
    const project = parser.exportProject(projectName);
    const allApps = project.apps;
    let apps = allApps;
    let scope = 'all';

    if (reportExportScope.value === 'selected') {
      const appIds = graph.selectedAppIds === null
        ? new Set(allApps.map(app => `app:${app.name}`))
        : graph.selectedAppIds;
      const selectedApps = allApps
        .filter(app => appIds.has(`app:${app.name}`))
        .map(app => app.name);
      if (selectedApps.length === 0) {
        throw new Error('Selecciona al menos una app en la lista o elige "Todo el proyecto".');
      }

      const includedNodeIds = new Set(selectedApps.map(name => `app:${name}`));
      const pendingNodeIds = [...includedNodeIds];
      while (pendingNodeIds.length > 0) {
        const targetId = pendingNodeIds.pop();
        for (const link of project.graph.links) {
          const linkTargetId = typeof link.target === 'object' ? link.target.id : link.target;
          if (linkTargetId !== targetId) continue;
          const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
          if (!includedNodeIds.has(sourceId)) {
            includedNodeIds.add(sourceId);
            pendingNodeIds.push(sourceId);
          }
        }
      }
      for (const app of allApps.filter(item => selectedApps.includes(item.name))) {
        (app.outputs || []).forEach(dataset => includedNodeIds.add(`ds:${dataset.toUpperCase()}`));
      }

      apps = allApps.filter(app => includedNodeIds.has(`app:${app.name}`));
      project.apps = apps;
      project.graph.nodes = project.graph.nodes.filter(node => includedNodeIds.has(node.id));
      project.graph.links = project.graph.links.filter(link => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
        const targetId = typeof link.target === 'object' ? link.target.id : link.target;
        return includedNodeIds.has(sourceId) && includedNodeIds.has(targetId);
      });
      project.datasetFields = project.datasetFields
        .filter(dataset => includedNodeIds.has(dataset.datasetId));
      project.fieldJourneys = project.fieldJourneys
        .map(field => ({
          ...field,
          steps: field.steps.filter(step => includedNodeIds.has(step.nodeId))
        }))
        .filter(field => field.steps.length > 0)
        .map(field => ({
          ...field,
          occurrences: new Set(field.steps.map(step => step.nodeId)).size
        }));
      project.graph.stats = {
        totalApps: project.graph.nodes.filter(node => node.type === 'APP').length,
        totalDatasets: project.graph.nodes.filter(node => !node.nodeRole).length,
        totalStg: project.graph.nodes.filter(node => node.type === 'STG').length,
        totalData: project.graph.nodes.filter(node => node.type === 'DATA').length,
        totalOther: project.graph.nodes.filter(node => node.type === 'FUENTE' || node.type === 'QVD').length,
        totalFields: project.fieldJourneys.length,
        totalLinks: project.graph.links.length,
        unconsumedCount: project.graph.nodes.filter(node => node.isUnconsumed).length,
        missingProducerCount: project.graph.nodes.filter(node => node.isMissingProducer).length
      };
      scope = 'selected';
      project.selectedApps = selectedApps;
      project.includedApps = apps.map(app => app.name);
    }

    project.exportScope = scope;
    project.selectedApps = project.selectedApps || apps.map(app => app.name);
    project.includedApps = project.includedApps || apps.map(app => app.name);
    return {
      projectName,
      exportedAt: project.exportDate,
      scope,
      scopeLabel: scope === 'all' ? 'Todo el proyecto' : 'Apps seleccionadas y su linaje conectado',
      applicationCount: apps.length,
      selectedApps: project.selectedApps,
      includedApps: project.includedApps,
      stats: project.graph.stats,
      apps,
      datasets: project.graph.nodes.filter(node => !node.nodeRole),
      links: project.graph.links,
      fields: project.fieldJourneys,
      project
    };
  }

  function safeFileName(name) {
    return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').trim() || 'Proyecto_Linaje';
  }

  function reportFileName(report, extension) {
    const scopeName = report.scope === 'all' ? 'completo' : 'seleccion';
    return `${safeFileName(report.projectName)}_linaje_${scopeName}.${extension}`;
  }

  function downloadFile(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function xmlEscape(value) {
    return String(value ?? '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function spreadsheetCell(value, reference) {
    const text = String(value ?? '');
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
  }

  function spreadsheetSheet(rows) {
    const columnName = index => {
      let name = '';
      for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
        name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
      }
      return name;
    };
    const rowXml = rows.map((row, rowIndex) => {
      const cells = row.map((value, columnIndex) =>
        spreadsheetCell(value, `${columnName(columnIndex)}${rowIndex + 1}`)
      ).join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>${rowXml}</sheetData>
        <pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
      </worksheet>`;
  }

  async function createExcelReport(report) {
    if (typeof JSZip === 'undefined') throw new Error('No se pudo cargar el generador de archivos Excel.');
    const zip = new JSZip();
    const summaryRows = [
      ['Reporte de linaje', report.projectName],
      ['Alcance', report.scopeLabel],
      ['Fecha de exportación', report.exportedAt],
      ['Registros de aplicaciones', report.applicationCount],
      ['Apps Qlik', report.stats.totalApps],
      ['Apps seleccionadas', report.selectedApps.join('; ')],
      ['Apps incluidas con linaje', report.includedApps.length],
      ['Datasets', report.stats.totalDatasets],
      ['Dependencias', report.stats.totalLinks],
      ['Campos', report.stats.totalFields],
      ['Datasets sin consumidor', report.stats.unconsumedCount],
      ['Datasets sin productor', report.stats.missingProducerCount],
      ['Apps incluidas', report.selectedApps.join('; ')]
    ];
    const applicationRows = [
      ['Aplicación', 'Origen de datos', 'Entradas', 'Salidas', 'Cantidad de campos', 'Vista previa'],
      ...report.apps.map(app => [
        app.name,
        app.details?.source || '',
        (app.inputs || []).join('; '),
        (app.outputs || []).join('; '),
        (app.fields || []).length,
        app.snippet || ''
      ])
    ];
    const datasetRows = [
      ['ID', 'Dataset', 'Tipo', 'Productores', 'Consumidores', 'Campos', 'Sin productor', 'Sin consumidor', 'Otros datos'],
      ...report.datasets.map(dataset => [
        dataset.id,
        dataset.name,
        dataset.type,
        JSON.stringify(dataset.producers || []),
        JSON.stringify(dataset.consumers || []),
        (dataset.fields || []).length,
        Boolean(dataset.isMissingProducer),
        Boolean(dataset.isUnconsumed),
        JSON.stringify({
          isOrphan: dataset.isOrphan,
          radius: dataset.radius
        })
      ])
    ];
    const dependencyRows = [
      ['ID', 'Origen', 'Destino', 'Tipo', 'Etiqueta'],
      ...report.links.map(link => [
        link.id,
        typeof link.source === 'object' ? link.source.id : link.source,
        typeof link.target === 'object' ? link.target.id : link.target,
        link.type,
        link.label || ''
      ])
    ];
    const fieldRows = [
      ['Campo', 'Clave', 'Ocurrencias', 'ID del nodo', 'Nodo', 'Tipo de nodo', 'Detalle del campo'],
      ...report.fields.flatMap(field => field.steps.map(step => [
        field.name,
        field.key,
        field.occurrences,
        step.nodeId,
        step.nodeName,
        step.nodeType,
        JSON.stringify(step.fieldInfo)
      ]))
    ];
    const contentRows = [['Tipo', 'Aplicación', 'Parte', 'Contenido']];
    const addContent = (type, appName, content) => {
      if (!content) return;
      const chunkSize = 30000;
      for (let offset = 0, part = 1; offset < content.length; part++) {
        let end = Math.min(offset + chunkSize, content.length);
        const lastCharacter = content.charCodeAt(end - 1);
        if (end < content.length && lastCharacter >= 0xD800 && lastCharacter <= 0xDBFF) end--;
        contentRows.push([type, appName, part, content.slice(offset, end)]);
        offset = end;
      }
    };
    for (const app of report.apps) {
      addContent('Script completo', app.name, app.fullScript || '');
      addContent('Detalles', app.name, JSON.stringify(app.details || {}));
    }

    const sheetNames = ['Resumen', 'Aplicaciones', 'Datasets', 'Dependencias', 'Campos', 'Contenido'];
    const sheetRows = [summaryRows, applicationRows, datasetRows, dependencyRows, fieldRows, contentRows];

    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        ${sheetNames.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
      </Types>`);
    zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>`);
    zip.folder('xl').file('workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets>${sheetNames.map((name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>
      </workbook>`);
    zip.folder('xl').folder('_rels').file('workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        ${sheetNames.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}
      </Relationships>`);
    const sheets = zip.folder('xl').folder('worksheets');
    sheetRows.forEach((rows, index) => sheets.file(`sheet${index + 1}.xml`, spreadsheetSheet(rows)));
    return zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  function pptTextShape(id, text, x, y, width, height, isTitle = false) {
    const paragraphs = text.split('\n').map(line => line
      ? `<a:p><a:r><a:rPr lang="es-ES" sz="${isTitle ? 2800 : 1500}" b="${isTitle ? 1 : 0}"><a:solidFill><a:srgbClr val="${isTitle ? '38BDF8' : 'E5E7EB'}"/></a:solidFill><a:latin typeface="Aptos"/></a:rPr><a:t xml:space="preserve">${xmlEscape(line)}</a:t></a:r><a:endParaRPr lang="es-ES"/></a:p>`
      : '<a:p><a:endParaRPr lang="es-ES"/></a:p>').join('');
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Texto ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
      <p:txBody><a:bodyPr wrap="square" anchor="t"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
  }

  function pptSlideXml(shapes) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
        <p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="0B0F19"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
          <p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
            <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}
          </p:spTree>
        </p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
      </p:sld>`;
  }

  function pptGraphPicture() {
    return `<p:pic><p:nvPicPr><p:cNvPr id="3" name="Grafo de linaje"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
      <p:spPr><a:xfrm><a:off x="457200" y="1371600"/><a:ext cx="11277600" cy="5029200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
    </p:pic>`;
  }

  async function createPowerPointReport(report) {
    if (typeof JSZip === 'undefined') throw new Error('No se pudo cargar el generador de presentaciones.');
    const reportNodeIds = new Set(report.project.graph.nodes.map(node => node.id));
    const visibleNodeIds = new Set(graph.nodes.map(node => node.id));
    const visibleNodesMatch = visibleNodeIds.size > 0 &&
      Array.from(visibleNodeIds).every(nodeId => reportNodeIds.has(nodeId));
    const graphMatchesReport = visibleNodesMatch &&
      (report.scope !== 'all' || visibleNodeIds.size === reportNodeIds.size);
    const graphDataUrl = graphMatchesReport ? graph.canvas.toDataURL('image/png') : '';
    if (graphMatchesReport && !graphDataUrl.startsWith('data:image/png;base64,')) {
      throw new Error('No se pudo capturar el grafo para la presentación.');
    }
    const zip = new JSZip();
    const slides = [];
    const stats = report.stats;
    const stamp = new Date(report.exportedAt).toLocaleString('es-AR');

    slides.push({
      xml: pptSlideXml(
        pptTextShape(2, report.projectName, 457200, 685800, 11277600, 914400, true) +
        pptTextShape(3, `${report.scopeLabel} · ${stamp}\n\nRegistros de aplicaciones: ${report.applicationCount}    Datasets: ${stats.totalDatasets}    Dependencias: ${stats.totalLinks}\nCampos identificados: ${stats.totalFields}    Datasets sin consumidor: ${stats.unconsumedCount}`, 685800, 2057400, 10820400, 3200400)
      )
    });
    const graphSlideMessage = report.scope === 'all'
      ? 'La imagen del grafo no coincide con el alcance completo. Pulsa «Todas» en el filtro de apps y vuelve a exportar para incluir el grafo completo.'
      : 'No hay nodos visibles del alcance seleccionado. Ajusta la selección o los filtros del grafo y vuelve a exportar.';
    slides.push({
      xml: pptSlideXml(
        pptTextShape(2, 'Grafo de dependencias', 457200, 457200, 11277600, 685800, true) +
        (graphMatchesReport
          ? pptGraphPicture()
          : pptTextShape(3, graphSlideMessage, 685800, 1371600, 10820400, 2500000))
      ),
      image: graphMatchesReport
    });

    const appsPerSlide = 6;
    for (let start = 0; start < report.apps.length; start += appsPerSlide) {
      const page = report.apps.slice(start, start + appsPerSlide);
      const body = page.map(app => {
        const inputs = app.inputs.join(', ') || 'Sin entradas registradas';
        const outputs = app.outputs.join(', ') || 'Sin salidas registradas';
        return `${app.name} (${(app.fields || []).length} campos)\n  Entradas: ${inputs}\n  Salidas: ${outputs}`;
      }).join('\n\n');
      slides.push({
        xml: pptSlideXml(
          pptTextShape(2, `Matriz de linaje (${start + 1}-${start + page.length})`, 457200, 457200, 11277600, 685800, true) +
          pptTextShape(3, body || 'No hay aplicaciones en el reporte.', 685800, 1371600, 10820400, 5029200)
        )
      });
    }

    const fieldsPerSlide = 8;
    for (let start = 0; start < report.fields.length; start += fieldsPerSlide) {
      const page = report.fields.slice(start, start + fieldsPerSlide);
      const body = page.map(field => {
        const journey = field.steps.map(step =>
          `${step.nodeName} (${step.nodeType})`
        ).join(' → ');
        const expressions = Array.from(new Set(field.steps
          .map(step => step.fieldInfo?.originalExpr)
          .filter(Boolean)));
        return `${field.name}\n  Linaje: ${journey || 'Sin recorrido'}${expressions.length ? `\n  Expresión: ${expressions.join(' | ')}` : ''}`;
      }).join('\n\n');
      slides.push({
        xml: pptSlideXml(
          pptTextShape(2, `Linaje de campos (${start + 1}-${start + page.length})`, 457200, 457200, 11277600, 685800, true) +
          pptTextShape(3, body, 685800, 1371600, 10820400, 5029200)
        )
      });
    }

    const presentationNs = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const officeRelNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const contentTypes = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Default Extension="png" ContentType="image/png"/>',
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
      '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
      '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
      '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
      ...slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`),
      '</Types>'].join('');
    zip.file('[Content_Types].xml', contentTypes);
    zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="${officeRelNs}/officeDocument" Target="ppt/presentation.xml"/>
      </Relationships>`);

    const ppt = zip.folder('ppt');
    ppt.file('presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${relNs}" xmlns:p="${presentationNs}">
        <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
        <p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('')}</p:sldIdLst>
        <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/>
      </p:presentation>`);
    ppt.folder('_rels').file('presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="${officeRelNs}/slideMaster" Target="slideMasters/slideMaster1.xml"/>
        ${slides.map((_, index) => `<Relationship Id="rId${index + 2}" Type="${officeRelNs}/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}
      </Relationships>`);

    const master = ppt.folder('slideMasters');
    master.file('slideMaster1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${relNs}" xmlns:p="${presentationNs}">
        <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
        <p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" tx1="dk1" tx2="dk2" hlink="hlink" folHlink="folHlink"/>
        <p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>
      </p:sldMaster>`);
    master.folder('_rels').file('slideMaster1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="${officeRelNs}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
        <Relationship Id="rId2" Type="${officeRelNs}/theme" Target="../theme/theme1.xml"/>
      </Relationships>`);
    const layout = ppt.folder('slideLayouts');
    layout.file('slideLayout1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${relNs}" xmlns:p="${presentationNs}" type="blank" preserve="1">
        <p:cSld name="En blanco"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
        <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
      </p:sldLayout>`);
    layout.folder('_rels').file('slideLayout1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="${officeRelNs}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
      </Relationships>`);
    ppt.folder('theme').file('theme1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Linaje">
        <a:themeElements><a:clrScheme name="Linaje"><a:dk1><a:srgbClr val="0B0F19"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="E5E7EB"/></a:lt2><a:accent1><a:srgbClr val="38BDF8"/></a:accent1><a:accent2><a:srgbClr val="34D399"/></a:accent2><a:accent3><a:srgbClr val="FBBF24"/></a:accent3><a:accent4><a:srgbClr val="C084FC"/></a:accent4><a:accent5><a:srgbClr val="F87171"/></a:accent5><a:accent6><a:srgbClr val="60A5FA"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
          <a:fontScheme name="Linaje"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme>
          <a:fmtScheme name="Linaje">
            <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="0" scaled="1"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="0" scaled="1"/></a:gradFill></a:fillStyleLst>
            <a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
            <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
            <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
          </a:fmtScheme>
        </a:themeElements>
      </a:theme>`);

    const slideFolder = ppt.folder('slides');
    for (const [index, slide] of slides.entries()) {
      slideFolder.file(`slide${index + 1}.xml`, slide.xml);
      if (slide.image) {
        const binary = atob(graphDataUrl.slice('data:image/png;base64,'.length));
        const bytes = new Uint8Array(binary.length);
        for (let byteIndex = 0; byteIndex < binary.length; byteIndex++) bytes[byteIndex] = binary.charCodeAt(byteIndex);
        ppt.folder('media').file('graph.png', bytes);
        slideFolder.folder('_rels').file(`slide${index + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
          <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1" Type="${officeRelNs}/image" Target="../media/graph.png"/>
          </Relationships>`);
      }
    }
    return zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    });
  }

  btnOpenTable.addEventListener('click', () => {
    populateMatrixTable();
    modalTable.classList.add('open');
  });

  btnCloseTable.addEventListener('click', () => {
    modalTable.classList.remove('open');
  });

  function populateMatrixTable() {
    tableBody.innerHTML = '';
    const graphData = parser.buildGraph();

    for (const [appName, app] of parser.apps.entries()) {
      const tr = document.createElement('tr');
      const inputsStr = app.inputs.length > 0 ? app.inputs.map(i => `<span style="color:var(--color-stg)">${i}</span>`).join('<br>') : '<span class="empty-text">Ninguno</span>';
      const outputsStr = app.outputs.length > 0 ? app.outputs.map(o => `<span style="color:var(--color-data)">${o}</span>`).join('<br>') : '<span class="empty-text">Ninguno</span>';

      tr.innerHTML = `
        <td><strong style="color:var(--color-app)">${appName}</strong></td>
        <td>${inputsStr}</td>
        <td>${outputsStr}</td>
        <td>
          <button class="btn btn-ghost" style="padding:4px 8px; font-size:0.75rem;" onclick="window.zoomToApp('${appName}')">
            🔍 Enfocar
          </button>
        </td>
      `;
      tableBody.appendChild(tr);
    }
  }

  window.zoomToApp = (appName) => {
    modalTable.classList.remove('open');
    graph.zoomToNode(`app:${appName}`);
  };

  btnExportCsv.addEventListener('click', () => {
    try {
      const report = getReportData();
      const csvCell = value => {
        let text = String(value ?? '');
        if (/^[=+\-@]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
      };
      const rows = [
        ['Tipo de registro', 'ID', 'Nombre', 'Aplicación', 'Origen', 'Destino', 'Información completa (JSON)'],
        ['Proyecto', report.project.version, report.projectName, '', '', '', JSON.stringify({
          scope: report.scopeLabel,
          exportedAt: report.exportedAt,
          selectedApps: report.selectedApps,
          stats: report.stats
        })],
        ...report.apps.map(app => ['Aplicación', `app:${app.name}`, app.name, app.name, '', '', JSON.stringify(app)]),
        ...report.datasets.map(dataset => ['Dataset', dataset.id, dataset.name, '', '', '', JSON.stringify(dataset)]),
        ...report.links.map(link => [
          'Dependencia',
          link.id,
          link.label || link.type,
          '',
          typeof link.source === 'object' ? link.source.id : link.source,
          typeof link.target === 'object' ? link.target.id : link.target,
          JSON.stringify(link)
        ]),
        ...report.fields.map(field => ['Campo', field.key, field.name, '', '', '', JSON.stringify(field)]),
        ...report.project.datasetFields.map(dataset => [
          'Campos de dataset',
          dataset.datasetId,
          dataset.datasetId.replace(/^ds:/, ''),
          '',
          '',
          '',
          JSON.stringify(dataset.fields)
        ])
      ];
      const csv = `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}`;
      downloadFile(new Blob([csv], { type: 'text/csv;charset=utf-8' }), reportFileName(report, 'csv'));
      showToast('Reporte completo exportado como CSV.');
    } catch (error) {
      showToast(`No se pudo exportar el CSV: ${error.message}`, 'error');
    }
  });

  btnExportExcel.addEventListener('click', async () => {
    try {
      const report = getReportData();
      const file = await createExcelReport(report);
      downloadFile(file, reportFileName(report, 'xlsx'));
      showToast('Reporte exportado como Excel.');
    } catch (error) {
      showToast(`No se pudo exportar el Excel: ${error.message}`, 'error');
    }
  });

  btnExportJson.addEventListener('click', () => {
    try {
      const report = getReportData();
      const json = JSON.stringify(report.project, null, 2);
      downloadFile(new Blob([json], { type: 'application/json;charset=utf-8' }), reportFileName(report, 'json'));
      showToast('Reporte completo exportado como JSON.');
    } catch (error) {
      showToast(`No se pudo exportar el JSON: ${error.message}`, 'error');
    }
  });

  btnExportPpt.addEventListener('click', async () => {
    try {
      const report = getReportData();
      const file = await createPowerPointReport(report);
      downloadFile(file, reportFileName(report, 'pptx'));
      showToast('Presentación exportada como PowerPoint.');
    } catch (error) {
      showToast(`No se pudo exportar el PowerPoint: ${error.message}`, 'error');
    }
  });
});
