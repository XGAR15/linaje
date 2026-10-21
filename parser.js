/**
 * Linaje - Motor de Análisis de Scripts Qlik con Linaje a Nivel de Campo (Column-Level Lineage)
 * Parsea scripts de carga, extrae tablas, campos, alias y genera el grafo de dependencias y linaje de columnas.
 */

class QlikLineageParser {
  constructor() {
    this.apps = new Map(); // name -> { name, script, inputs, outputs, fields, details }
    this.datasets = new Map(); // id -> { id, name, type, producers, consumers, fields }
    this.datasetFields = new Map(); // datasetId -> Map(fieldNameLower -> fieldObj)
    this.appFields = new Map(); // appName -> Map(fieldNameLower -> fieldObj)
    this.fieldJourneyMap = new Map(); // fieldNameLower -> { name, nodes: Set(), steps: [] }
    this.links = [];
  }

  reset() {
    this.apps.clear();
    this.datasets.clear();
    this.datasetFields.clear();
    this.appFields.clear();
    this.fieldJourneyMap.clear();
    this.links = [];
  }

  cleanComments(script) {
    if (!script) return '';
    let clean = script.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ');
    clean = clean.replace(/(?<!:)\/\/[^\r\n]*/g, ' ');
    return clean;
  }

  cleanPath(pathStr) {
    if (!pathStr) return '';
    let cleaned = pathStr.trim().replace(/^['"\[]+|['"\]]+$/g, '');

    const qlikPattern = /((?:DATA|STG)_[A-Za-z0-9_\?\*\-]+(?:\.[A-Za-z0-9]+)?)/gi;
    const matches = cleaned.match(qlikPattern);

    if (matches && matches.length > 0) {
      const conExt = matches.filter(m => m.includes('.'));
      if (conExt.length > 0) {
        return conExt[conExt.length - 1].replace(/[\[\]\(\);,'"]/g, '').trim();
      }
      return matches[matches.length - 1].replace(/[\[\]\(\);,'"]/g, '').trim();
    }

    const fileMatch = cleaned.match(/([A-Za-z0-9_\-\.]+\.(?:qvd|csv|xlsx?|parquet|txt))/i);
    if (fileMatch) {
      return fileMatch[1].trim();
    }

    const segments = cleaned.split(/[\/\\]/);
    const lastSeg = segments[segments.length - 1].replace(/[\[\]\(\);,'"]/g, '').trim();
    if (lastSeg && !lastSeg.startsWith('$(') && lastSeg.length > 2) {
      return lastSeg;
    }

    return '';
  }

  classifyDataset(name) {
    const upper = name.toUpperCase();
    if (upper.startsWith('STG_')) return 'STG';
    if (upper.startsWith('DATA_')) return 'DATA';
    if (upper.endsWith('.QVD')) return 'QVD';
    return 'FUENTE';
  }

  /**
   * Extrae la lista de campos individuales de un bloque de sentencia LOAD
   */
  extractFieldsFromClause(clauseText) {
    if (!clauseText) return [];
    const fields = [];
    let current = '';
    let parenDepth = 0;
    let bracketDepth = 0;

    for (let i = 0; i < clauseText.length; i++) {
      const ch = clauseText[i];
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === '[') bracketDepth++;
      else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);

      if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
        if (current.trim()) fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) fields.push(current.trim());

    const parsed = [];
    for (const rawField of fields) {
      const singleLine = rawField.replace(/[\r\n\t]+/g, ' ').trim();
      if (!singleLine || singleLine === '*') continue;

      // Detectar expresión con alias: Expr AS Alias
      const asMatch = singleLine.match(/(.+?)\s+AS\s+(\[[^\]]+\]|"[^"]+"|'[^']+'|[^\s]+)\s*$/i);
      if (asMatch) {
        const expr = asMatch[1].trim();
        const alias = asMatch[2].replace(/[\[\]"']/g, '').trim();
        parsed.push({
          name: alias,
          originalExpr: expr,
          hasAlias: true
        });
      } else {
        const simple = singleLine.replace(/[\[\]"']/g, '').trim();
        parsed.push({
          name: simple,
          originalExpr: simple,
          hasAlias: false
        });
      }
    }
    return parsed;
  }

  extractFieldsFromLoadStatement(statement) {
    const match = String(statement || '').match(/\bLOAD\s+(?:DISTINCT\s+)?([\s\S]+?)\s+(?:FROM\b|RESIDENT\b)/i);
    return match ? this.extractFieldsFromClause(match[1]) : [];
  }

  /**
   * Parsea el texto del script para una aplicación determinada
   */
  parseAppScript(appName, scriptText) {
    const cleanText = this.cleanComments(scriptText);
    const inputs = new Set();
    const outputs = new Set();
    const rawInputs = [];
    const rawOutputs = [];

    if (!this.appFields.has(appName)) {
      this.appFields.set(appName, new Map());
    }
    const currentAppFields = this.appFields.get(appName);

    // 1. Extraer STORE ... INTO ...
    const storeRegex = /STORE\s+([A-Za-z0-9_\[\]]+)?\s*INTO\s+(?:\[([^\]]+)\]|([^;\r\n]+))/gi;
    let match;
    while ((match = storeRegex.exec(cleanText)) !== null) {
      const rawPath = match[2] || match[3] || '';
      const cleaned = this.cleanPath(rawPath);
      if (cleaned) {
        outputs.add(cleaned);
        rawOutputs.push({ raw: rawPath.trim(), cleaned, table: (match[1] || '').trim() });
      }
    }

    // 2. Extraer FROM ...
    const fromRegex = /FROM\s+(?:\[([^\]]+)\]|([^;\r\n\(\[]+))/gi;
    while ((match = fromRegex.exec(cleanText)) !== null) {
      const rawPath = match[1] || match[2] || '';
      const cleaned = this.cleanPath(rawPath);
      if (cleaned) {
        inputs.add(cleaned);
        rawInputs.push({ raw: rawPath.trim(), cleaned });
      }
    }

    // 3. Extraer BINARY ...
    const binaryRegex = /BINARY\s+(?:\[([^\]]+)\]|([^;\r\n]+))/gi;
    while ((match = binaryRegex.exec(cleanText)) !== null) {
      const rawPath = match[1] || match[2] || '';
      const cleaned = this.cleanPath(rawPath);
      if (cleaned) {
        inputs.add(cleaned);
        rawInputs.push({ raw: rawPath.trim(), cleaned, isBinary: true });
      }
    }

    // 4. Extraer Bloques LOAD con Campos
    // Patrón: LOAD (campos) FROM [origen]
    const loadFromRegex = /LOAD\s+(?:DISTINCT\s+)?([\s\S]+?)\s+(?:FROM\s+(?:\[([^\]]+)\]|([^;\r\n\(\[]+))|RESIDENT\s+([A-Za-z0-9_\[\]]+))/gi;
    let loadMatch;
    while ((loadMatch = loadFromRegex.exec(cleanText)) !== null) {
      const fieldsClause = loadMatch[1] || '';
      const fromPath = loadMatch[2] || loadMatch[3] || loadMatch[4] || '';
      const datasetName = this.cleanPath(fromPath);
      const parsedFields = this.extractFieldsFromClause(fieldsClause);

      for (const field of parsedFields) {
        const key = field.name.toLowerCase();
        currentAppFields.set(key, field);

        // Si se extrajo de un dataset de origen, asociar al dataset
        if (datasetName) {
          const dsId = `ds:${datasetName.toUpperCase()}`;
          if (!this.datasetFields.has(dsId)) {
            this.datasetFields.set(dsId, new Map());
          }
          this.datasetFields.get(dsId).set(key, field);
        }

        // Si la app produce salidas, asociar también los campos a los datasets de salida
        outputs.forEach(outName => {
          const outDsId = `ds:${outName.toUpperCase()}`;
          if (!this.datasetFields.has(outDsId)) {
            this.datasetFields.set(outDsId, new Map());
          }
          this.datasetFields.get(outDsId).set(key, field);
        });
      }
    }

    this.apps.set(appName, {
      name: appName,
      scriptLength: scriptText.length,
      rawScriptSnippet: scriptText.slice(0, 1500),
      fullScript: scriptText,
      inputs: Array.from(inputs),
      outputs: Array.from(outputs),
      fields: Array.from(currentAppFields.values()),
      details: { rawInputs, rawOutputs }
    });
  }

  /**
   * Extrae metadatos y campos directamente de la cabecera XML de archivos QVD reales
   */
  parseQvdHeader(fileName, headerXmlText) {
    const datasetName = fileName.replace(/\.[^/.]+$/, '').toUpperCase();
    const dsId = `ds:${datasetName}.QVD`;

    if (!this.datasetFields.has(dsId)) {
      this.datasetFields.set(dsId, new Map());
    }
    const map = this.datasetFields.get(dsId);

    const fieldRegex = /<QvdFieldHeader>[\s\S]*?<FieldName>([\s\S]*?)<\/FieldName>/gi;
    let m;
    while ((m = fieldRegex.exec(headerXmlText)) !== null) {
      const fname = (m[1] || '').trim();
      if (fname) {
        map.set(fname.toLowerCase(), {
          name: fname,
          originalExpr: fname,
          hasAlias: false,
          sourceQvd: fileName
        });
      }
    }
  }

  /**
   * Extracción "best-effort" del script de carga embebido en un archivo binario .qvf.
   * El .qvf de Qlik Sense es un formato propietario (no texto plano, no ZIP), pero el
   * texto del script suele quedar legible dentro del binario. Se decodifica el buffer
   * con distintos charsets y se extraen las corridas de caracteres imprimibles (al estilo
   * del comando `strings`), dejando que las regex de parseAppScript filtren lo relevante.
   */
  extractScriptFromQvfBuffer(arrayBuffer) {
    const runRegex = /[\x20-\x7E¡-ɏ]{6,}/g;
    const chunks = [];

    const scanWith = (decoderLabel) => {
      try {
        const decoder = new TextDecoder(decoderLabel, { fatal: false });
        const text = decoder.decode(arrayBuffer);
        const runs = text.match(runRegex);
        if (runs) chunks.push(runs.join('\n'));
      } catch (e) {
        // Charset no soportado por el navegador, se ignora esa pasada
      }
    };

    scanWith('utf-16le');
    scanWith('windows-1252');

    return chunks.join('\n');
  }

  /**
   * Lee un File/Blob de un .qvf aplicando un límite de tamaño (los .qvf pueden pesar
   * cientos de MB por el cache de datos; solo se escanea el inicio y el final en busca
   * del bloque de script, que es "best-effort" y no garantiza encontrarlo siempre).
   */
  async extractScriptFromQvfFile(file) {
    const MAX_SCAN = 60 * 1024 * 1024;
    const TAIL_SCAN = 10 * 1024 * 1024;

    if (file.size <= MAX_SCAN) {
      const buffer = await file.arrayBuffer();
      return this.extractScriptFromQvfBuffer(buffer);
    }

    const headBuffer = await file.slice(0, MAX_SCAN).arrayBuffer();
    const tailBuffer = await file.slice(Math.max(0, file.size - TAIL_SCAN)).arrayBuffer();
    return this.extractScriptFromQvfBuffer(headBuffer) + '\n' + this.extractScriptFromQvfBuffer(tailBuffer);
  }

  processLoadscriptJson(appName, jsonContent) {
    let scriptText = '';
    try {
      const data = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
      if (Array.isArray(data)) {
        scriptText = data.map(sec => {
          if (sec && sec.qText) return sec.qText;
          if (typeof sec === 'string') return sec;
          return '';
        }).join('\n\n// --- SECCION ---\n\n');
      } else if (typeof data === 'object' && data !== null) {
        scriptText = data.script || data.qText || JSON.stringify(data);
      }
    } catch (e) {
      scriptText = jsonContent;
    }
    this.parseAppScript(appName, scriptText);
  }

  parseDelimitedText(content, delimiter) {
    const rows = [];
    let row = [];
    let value = '';
    let inQuotes = false;

    for (let index = 0; index < content.length; index++) {
      const character = content[index];
      if (character === '"') {
        if (inQuotes && content[index + 1] === '"') {
          value += '"';
          index++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (!inQuotes && character === delimiter) {
        row.push(value);
        value = '';
      } else if (!inQuotes && (character === '\n' || character === '\r')) {
        if (character === '\r' && content[index + 1] === '\n') index++;
        row.push(value);
        if (row.some(cell => cell.trim())) rows.push(row);
        row = [];
        value = '';
      } else {
        value += character;
      }
    }

    row.push(value);
    if (row.some(cell => cell.trim())) rows.push(row);
    return rows;
  }

  processQlikModelCsv(csvContent, fallbackName = 'Qlik Model') {
    const firstLine = (csvContent || '').split(/\r?\n/, 1)[0] || '';
    const delimiter = [';', ',', '\t'].reduce((best, candidate) => {
      const count = firstLine.split(candidate).length - 1;
      return count > best.count ? { delimiter: candidate, count } : best;
    }, { delimiter: ',', count: -1 }).delimiter;
    const rows = this.parseDelimitedText(csvContent || '', delimiter);
    if (rows.length < 2) throw new Error('El CSV no contiene filas de datos.');

    const headers = rows[0].map((header, index) =>
      (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim().toLowerCase()
    );
    const columnIndex = (...names) => headers.findIndex(header => names.includes(header));
    const appIdIndex = columnIndex('app_id', 'appid', 'id_app');
    const appNameIndex = columnIndex('app_nombre', 'app_name', 'appname', 'nombre_app');
    const streamIndex = columnIndex('stream', 'flujo');
    const reloadIndex = columnIndex('ultima_recarga', 'last_reload', 'reload_time');
    const tableIndex = columnIndex('tabla', 'table', 'table_name');
    const fieldIndex = columnIndex('campo', 'field', 'field_name');

    if (tableIndex === -1 || fieldIndex === -1) {
      throw new Error('El CSV debe incluir las columnas "tabla" y "campo".');
    }

    const groupedApps = new Map();
    for (const values of rows.slice(1)) {
      const getValue = index => index === -1 ? '' : (values[index] || '').trim();
      const appId = getValue(appIdIndex);
      const appName = getValue(appNameIndex) || fallbackName;
      const tableName = getValue(tableIndex);
      const fieldName = getValue(fieldIndex);
      if (!tableName || !fieldName) continue;

      const appKey = appId || appName;
      if (!groupedApps.has(appKey)) {
        groupedApps.set(appKey, {
          appId,
          appName,
          stream: getValue(streamIndex),
          lastReload: getValue(reloadIndex),
          tables: new Map()
        });
      }

      const app = groupedApps.get(appKey);
      if (!app.tables.has(tableName)) app.tables.set(tableName, new Map());
      const tableFields = app.tables.get(tableName);
      const fieldKey = fieldName.toLowerCase();
      if (!tableFields.has(fieldKey)) {
        tableFields.set(fieldKey, {
          name: fieldName,
          originalExpr: fieldName,
          hasAlias: false,
          sourceTable: tableName
        });
      }
    }

    if (groupedApps.size === 0) throw new Error('El CSV no contiene filas con tabla y campo.');

    for (const app of groupedApps.values()) {
      let appName = app.appName || app.appId || fallbackName;
      if (this.apps.has(appName) && this.apps.get(appName).details?.appId !== app.appId) {
        appName = `${appName} (${app.appId || 'CSV'})`;
      }

      const appFields = new Map();
      const tableNames = [];
      for (const [tableName, fields] of app.tables) {
        tableNames.push(tableName);
        for (const [fieldKey, field] of fields) {
          appFields.set(fieldKey, field);
        }
      }

      this.appFields.set(appName, appFields);
      const summary = [
        `Modelo de datos Qlik${app.appId ? ` | ID: ${app.appId}` : ''}`,
        app.stream ? `Stream: ${app.stream}` : '',
        app.lastReload ? `Última recarga: ${app.lastReload}` : '',
        `Tablas del modelo: ${tableNames.length}`,
        `Campos: ${appFields.size}`
      ].filter(Boolean).join('\n');
      // Conserva entradas/salidas si la app ya llegó de otro origen (p. ej. el CSV de entradas/salidas)
      const existingApp = this.apps.get(appName);
      const summaries = { ...existingApp?.details?.summaries, 'qlik-model-csv': summary };
      this.apps.set(appName, {
        name: appName,
        scriptLength: existingApp?.scriptLength || 0,
        rawScriptSnippet: this.composeSnippet(existingApp, summaries),
        fullScript: existingApp?.fullScript || '',
        inputs: existingApp?.inputs || [],
        outputs: existingApp?.outputs || [],
        fields: Array.from(appFields.values()),
        details: {
          ...existingApp?.details,
          source: existingApp?.details?.source || 'qlik-model-csv',
          appId: app.appId,
          stream: app.stream,
          lastReload: app.lastReload,
          summaries
        }
      });
    }

    return groupedApps.size;
  }

  /** Vista previa del inspector: el script si existe; si no, un bloque por cada CSV cargado. */
  composeSnippet(existingApp, summaries) {
    if (existingApp?.fullScript) return existingApp.rawScriptSnippet;
    return Object.values(summaries).join('\n\n');
  }

  processQlikCsv(csvContent, fallbackName = 'Qlik Model') {
    const firstLine = (csvContent || '').split(/\r?\n/, 1)[0] || '';
    const delimiter = [';', ',', '\t'].reduce((best, candidate) => {
      const count = firstLine.split(candidate).length - 1;
      return count > best.count ? { delimiter: candidate, count } : best;
    }, { delimiter: ',', count: -1 }).delimiter;
    const rows = this.parseDelimitedText(csvContent || '', delimiter);
    const headers = (rows[0] || []).map((header, index) =>
      (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim().toLowerCase()
    );

    if (headers.includes('tarea') && headers.includes('app') &&
        (headers.includes('origenes_del_disparo') || headers.includes('raices'))) {
      return this.processQlikChainCsv(csvContent, delimiter);
    }
    if (headers.includes('direccion') && (headers.includes('recurso') || headers.includes('recurso_resuelto'))) {
      return this.processQlikIoCsv(csvContent, delimiter, fallbackName);
    }
    return this.processQlikModelCsv(csvContent, fallbackName);
  }

  processQlikChainCsv(csvContent, delimiter = ';') {
    const rows = this.parseDelimitedText(csvContent || '', delimiter);
    if (rows.length < 2) throw new Error('El CSV de cadenas no contiene filas de datos.');

    const headers = rows[0].map((header, index) =>
      (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim().toLowerCase()
    );
    const columnIndex = (...names) => headers.findIndex(header => names.includes(header));
    const taskIndex = columnIndex('tarea', 'task');
    const appIndex = columnIndex('app', 'app_nombre', 'app_name');
    const originsIndex = columnIndex('origenes_del_disparo', 'origenes', 'triggers');
    const rootsIndex = columnIndex('raices', 'roots');
    const enabledIndex = columnIndex('habilitada', 'enabled');
    if (taskIndex === -1 || appIndex === -1) {
      throw new Error('El CSV de cadenas debe incluir las columnas "tarea" y "app".');
    }

    const getValue = (values, index) => index === -1 ? '' : (values[index] || '').trim();
    const sourceRows = rows.slice(1).map(values => ({
      task: getValue(values, taskIndex),
      appName: getValue(values, appIndex) || getValue(values, taskIndex),
      origins: getValue(values, originsIndex),
      roots: getValue(values, rootsIndex),
      enabled: getValue(values, enabledIndex)
    })).filter(row => row.task && row.appName);

    if (sourceRows.length === 0) throw new Error('El CSV de cadenas no contiene tareas válidas.');

    const normalize = value => value.trim().toLocaleLowerCase();
    const taskToApp = new Map();
    const appByName = new Map();
    const groupedApps = new Map();
    for (const row of sourceRows) {
      taskToApp.set(normalize(row.task), row.appName);
      appByName.set(normalize(row.appName), row.appName);
      if (!groupedApps.has(row.appName)) {
        groupedApps.set(row.appName, { upstreamApps: new Set(), tasks: new Set(), enabled: row.enabled });
      }
      groupedApps.get(row.appName).tasks.add(row.task);
    }

    const splitNames = value => value.split(/\s*;;\s*/).map(name => name.trim()).filter(Boolean);
    for (const row of sourceRows) {
      const upstreamApps = groupedApps.get(row.appName).upstreamApps;
      const originNames = splitNames(row.origins).map(origin => origin.split(/\s+@\s+/)[0].trim());
      const roots = splitNames(row.roots);
      const resolvedOrigins = originNames
        .map(name => taskToApp.get(normalize(name)) || appByName.get(normalize(name)))
        .filter(name => name && normalize(name) !== normalize(row.appName));
      const resolvedRoots = roots
        .map(name => taskToApp.get(normalize(name)) || appByName.get(normalize(name)))
        .filter(name => name && normalize(name) !== normalize(row.appName));

      for (const upstreamApp of resolvedOrigins.length > 0 ? resolvedOrigins : resolvedRoots) {
        upstreamApps.add(upstreamApp);
      }
    }

    for (const [appName, chain] of groupedApps) {
      const existingApp = this.apps.get(appName);
      const fields = this.appFields.get(appName) || new Map();
      this.appFields.set(appName, fields);
      const dependencies = Array.from(chain.upstreamApps);
      const summary = [
        `Cadena QMC${chain.enabled ? ` | Habilitada: ${chain.enabled}` : ''}`,
        `Tareas: ${chain.tasks.size}`,
        `Dependencias: ${dependencies.length}`,
        dependencies.length ? `Orígenes: ${dependencies.join(', ')}` : 'Origen raíz'
      ].join('\n');

      this.apps.set(appName, {
        name: appName,
        scriptLength: existingApp?.scriptLength || 0,
        rawScriptSnippet: summary,
        inputs: existingApp?.inputs || [],
        outputs: existingApp?.outputs || [],
        fields: Array.from(fields.values()),
        details: { ...existingApp?.details, source: 'qmc-chain-csv', upstreamApps: dependencies, tasks: Array.from(chain.tasks) }
      });
    }

    return groupedApps.size;
  }

  /** Último segmento de una ruta Qlik, sin corchetes, llaves ni comillas envolventes. */
  ioBaseName(value) {
    const cleaned = (value || '').trim().replace(/^[\s{\['"]+|[\s}\]'"]+$/g, '');
    const segments = cleaned.split(/[\/\\]/);
    return segments[segments.length - 1].trim();
  }

  /**
   * Lee la ruta que sigue a FROM/INTO en una sentencia, uniendo los tramos entre comillas o
   * corchetes con el texto contiguo ('lib://STG/QVD/STG_N10_'TABLA.QVD -> lib://STG/QVD/STG_N10_TABLA.QVD).
   * Devuelve '' si la sentencia termina antes de cerrar la ruta (sentencia truncada en el CSV).
   */
  ioStatementPath(statement, keyword) {
    const keywordRegex = new RegExp(`\\b${keyword}\\s+`, 'gi');
    let match;
    while ((match = keywordRegex.exec(statement)) !== null) {
      let index = match.index + match[0].length;
      let path = '';
      let closed = false;
      while (index < statement.length) {
        const character = statement[index];
        if (character === '[' || character === '"' || character === "'") {
          const end = statement.indexOf(character === '[' ? ']' : character, index + 1);
          if (end === -1) break;
          path += statement.slice(index + 1, end);
          index = end + 1;
        } else if (/[(;,]/.test(character)) {
          closed = true;
          break;
        } else {
          path += character;
          index++;
        }
      }
      if (index >= statement.length && /['"\]]$/.test(statement)) closed = true;
      // Ruta sin comillas seguida de otras cláusulas: cortar en el primer nombre de archivo completo
      const fileMatch = path.match(/^(.*?\.[A-Za-z0-9]{1,8})(?=\s|$)/);
      if (closed && fileMatch) return fileMatch[1].trim();
    }
    return '';
  }

  /**
   * Expresiones regulares para un nombre con $(variables) o comodines (*, ?):
   * - loose: cualquier valor en las partes variables.
   * - family: solo números (202405, 2024_05...), es decir, una familia de archivos por período.
   */
  ioPatternMatchers(name) {
    const parts = name.toUpperCase().split(/(\$\([^)]*\)|\*|\?)/);
    const toRegex = (variable, single) => new RegExp(`^${parts.map(part => {
      if (part === '?') return single;
      if (part === '*' || part.startsWith('$(')) return variable;
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('')}$`);
    return { loose: toRegex('.*', '.'), family: toRegex('[0-9][0-9_\\-]*', '[0-9]') };
  }

  /**
   * CSV de entradas/salidas por app (export qlik_io): una fila por cada LOAD, STORE, BINARY
   * o INCLUDE encontrado en el script (origen SCRIPT) o en el linaje de la última recarga
   * (origen LINEAGE). Ambos orígenes se unifican por nombre de archivo, que es la misma
   * clave que usan los scripts y los QVD para formar los nodos del grafo.
   */
  processQlikIoCsv(csvContent, delimiter = ';', fallbackName = 'Qlik App') {
    const rows = this.parseDelimitedText(csvContent || '', delimiter);
    if (rows.length < 2) throw new Error('El CSV de entradas/salidas no contiene filas de datos.');

    const headers = rows[0].map((header, index) =>
      (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim().toLowerCase()
    );
    const columnIndex = (...names) => headers.findIndex(header => names.includes(header));
    const columns = {
      appId: columnIndex('app_id', 'appid', 'id_app'),
      appName: columnIndex('app_nombre', 'app_name', 'appname', 'nombre_app'),
      stream: columnIndex('stream', 'flujo'),
      reload: columnIndex('ultima_recarga', 'last_reload', 'reload_time'),
      direction: columnIndex('direccion', 'direction'),
      type: columnIndex('tipo', 'type'),
      connection: columnIndex('conexion', 'connection'),
      resource: columnIndex('recurso', 'resource'),
      resolved: columnIndex('recurso_resuelto', 'resolved_resource'),
      statement: columnIndex('sentencia', 'statement'),
      table: columnIndex('tabla', 'table', 'table_name')
    };
    if (columns.direction === -1 || (columns.resource === -1 && columns.resolved === -1)) {
      throw new Error('El CSV de entradas/salidas debe incluir las columnas "direccion" y "recurso".');
    }

    // Las rutas del linaje llegan en minúsculas: se conserva la variante con mayúsculas del script
    const displayNames = new Map();
    const rememberName = name => {
      const key = name.toUpperCase();
      const current = displayNames.get(key);
      if (!current || (current === current.toLowerCase() && name !== name.toLowerCase())) {
        displayNames.set(key, name);
      }
      return key;
    };
    const hasExtension = name => /\.[A-Za-z0-9]{1,8}$/.test(name);
    const isPattern = name => /\$\(|[*?]/.test(name);
    const appIdRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    const groupedApps = new Map();
    for (const values of rows.slice(1)) {
      const getValue = index => index === -1 ? '' : (values[index] || '').trim();
      const appId = getValue(columns.appId);
      const appName = getValue(columns.appName) || appId || fallbackName;
      const appKey = appId || appName;
      if (!groupedApps.has(appKey)) {
        groupedApps.set(appKey, {
          appId,
          appName,
          stream: getValue(columns.stream),
          lastReload: getValue(columns.reload),
          inputs: new Set(),
          outputs: new Set(),
          patterns: { INPUT: new Set(), OUTPUT: new Set() },
          binaryAppIds: new Set(),
          includes: new Set(),
          unresolved: new Set(),
          fields: new Map(),
          datasetFields: new Map()
        });
      }

      const app = groupedApps.get(appKey);
      const direction = getValue(columns.direction).toUpperCase();
      const type = getValue(columns.type).toUpperCase();
      const resource = getValue(columns.resource);
      const resolved = getValue(columns.resolved) || resource;
      const statement = getValue(columns.statement);
      const tableName = getValue(columns.table);
      const statementFields = this.extractFieldsFromLoadStatement(statement);
      statementFields.forEach(field => {
        const fieldInfo = { ...field, sourceTable: tableName || undefined };
        app.fields.set(field.name.toLowerCase(), fieldInfo);
      });

      if (direction === 'DEPENDENCIA') {
        const include = this.ioBaseName(resolved);
        if (include) app.includes.add(include);
        continue;
      }
      // INTERNO (RESIDENT) e INLINE no salen de la app: no generan nodos en el grafo
      if (direction !== 'INPUT' && direction !== 'OUTPUT') continue;
      if (type === 'INLINE' || type === 'RESIDENT' || /^\{?\s*RESIDENT\s/i.test(resolved)) continue;

      const target = direction === 'INPUT' ? app.inputs : app.outputs;
      const binaryId = (type === 'BINARY' || /^binary\b/i.test(statement)) && resolved.match(appIdRegex);
      if (binaryId) {
        app.binaryAppIds.add(binaryId[0].toLowerCase());
        continue;
      }
      if (type === 'SQL') {
        const source = getValue(columns.connection) || resolved;
        if (source) target.add(rememberName(source));
        continue;
      }

      const candidates = [
        this.ioBaseName(resolved),
        this.ioBaseName(resource),
        this.ioBaseName(this.ioStatementPath(statement, direction === 'INPUT' ? 'FROM' : 'INTO'))
      ].filter(hasExtension);
      const name = candidates.find(candidate => !isPattern(candidate)) || candidates[0];
      if (!name) {
        app.unresolved.add(`${direction} ${type}: ${resolved || statement.slice(0, 120)}`);
      } else if (isPattern(name)) {
        app.patterns[direction].add(name);
      } else {
        const datasetKey = rememberName(name);
        target.add(datasetKey);
        if (direction === 'INPUT' && statementFields.length > 0) {
          if (!app.datasetFields.has(datasetKey)) app.datasetFields.set(datasetKey, new Map());
          const datasetFields = app.datasetFields.get(datasetKey);
          statementFields.forEach(field => {
            datasetFields.set(field.name.toLowerCase(), { ...field, sourceTable: tableName || undefined });
          });
        }
      }
    }

    if (groupedApps.size === 0) throw new Error('El CSV de entradas/salidas no contiene apps.');

    // Rutas del script con $(variables) o comodines, resueltas contra los archivos concretos:
    // 1. Si coinciden 2+ archivos por período (X_202401.QVD, X_202402.QVD...), se agrupan en un
    //    solo nodo con el nombre del patrón, que une al productor con los consumidores.
    // 2. Si la misma app ya trae el archivo concreto desde el linaje, el patrón sobra.
    // 3. Si un único archivo de cualquier app coincide, el patrón se resuelve a ese archivo.
    // Las salidas van primero para que la familia lleve el nombre que usa el productor.
    const concreteKeys = Array.from(new Set(Array.from(groupedApps.values())
      .flatMap(app => [...app.inputs, ...app.outputs])));
    const aliases = new Map();
    for (const direction of ['OUTPUT', 'INPUT']) {
      for (const app of groupedApps.values()) {
        const target = direction === 'INPUT' ? app.inputs : app.outputs;
        const ownKeys = Array.from(target);
        for (const pattern of app.patterns[direction]) {
          const { loose, family } = this.ioPatternMatchers(pattern);
          const familyKeys = concreteKeys.filter(key => family.test(key));
          if (familyKeys.length >= 2) {
            const patternKey = rememberName(pattern);
            const canonical = familyKeys.map(key => aliases.get(key)).find(Boolean) || patternKey;
            if (canonical !== patternKey) aliases.set(patternKey, canonical);
            familyKeys.forEach(key => aliases.set(key, canonical));
            target.add(patternKey);
          } else if (!ownKeys.some(key => loose.test(key))) {
            const looseKeys = concreteKeys.filter(key => loose.test(key));
            target.add(looseKeys.length === 1 ? looseKeys[0] : rememberName(pattern));
          }
        }
      }
    }
    const resolveAlias = key => {
      for (let hops = 0; aliases.has(key) && hops < 10; hops++) key = aliases.get(key);
      return key;
    };
    for (const app of groupedApps.values()) {
      app.inputs = new Set(Array.from(app.inputs, resolveAlias));
      app.outputs = new Set(Array.from(app.outputs, resolveAlias));
      app.datasetFields = new Map(Array.from(app.datasetFields, ([key, fields]) => {
        const canonicalKey = resolveAlias(key);
        const canonicalFields = app.datasetFields.get(canonicalKey) || new Map();
        fields.forEach((field, fieldKey) => canonicalFields.set(fieldKey, field));
        return [canonicalKey, canonicalFields];
      }));
    }

    const appNameById = new Map();
    for (const [name, existingApp] of this.apps) {
      if (existingApp.details?.appId) appNameById.set(existingApp.details.appId.toLowerCase(), name);
    }
    // Mismo nombre con otro ID (ya cargada o repetida en este CSV): se distingue con el ID
    const claimedIds = new Map();
    for (const app of groupedApps.values()) {
      let appName = app.appName;
      const existingId = this.apps.get(appName)?.details?.appId;
      const conflictsWithLoaded = existingId && app.appId && existingId !== app.appId;
      const conflictsInCsv = claimedIds.has(appName) && claimedIds.get(appName) !== app.appId;
      if (conflictsWithLoaded || conflictsInCsv) appName = `${appName} (${app.appId || 'CSV'})`;
      claimedIds.set(appName, app.appId);
      app.finalName = appName;
      if (app.appId) appNameById.set(app.appId.toLowerCase(), appName);
    }

    const mergeNames = (...lists) => {
      const byKey = new Map();
      for (const name of lists.flat()) {
        if (name && !byKey.has(name.toUpperCase())) byKey.set(name.toUpperCase(), name);
      }
      return Array.from(byKey.values());
    };

    for (const app of groupedApps.values()) {
      const appName = app.finalName;
      const existingApp = this.apps.get(appName);
      const upstreamApps = [];
      for (const binaryId of app.binaryAppIds) {
        const sourceApp = appNameById.get(binaryId);
        if (sourceApp && sourceApp !== appName) upstreamApps.push(sourceApp);
        else if (!sourceApp) app.inputs.add(rememberName(`BINARY ${binaryId}`));
      }
      const inputs = Array.from(app.inputs, key => displayNames.get(key));
      const outputs = Array.from(app.outputs, key => displayNames.get(key));
      const unresolved = Array.from(app.unresolved);

      const summary = [
        `Entradas/salidas Qlik${app.appId ? ` | ID: ${app.appId}` : ''}`,
        app.stream ? `Stream: ${app.stream}` : '',
        app.lastReload ? `Última recarga: ${app.lastReload}` : '',
        `Entradas: ${inputs.length} | Salidas: ${outputs.length}`,
        upstreamApps.length ? `BINARY de: ${upstreamApps.join(', ')}` : '',
        app.includes.size ? `Includes: ${Array.from(app.includes).join(', ')}` : '',
        unresolved.length ? `Rutas sin resolver (${unresolved.length}):\n  ${unresolved.slice(0, 15).join('\n  ')}` : ''
      ].filter(Boolean).join('\n');

      const fields = this.appFields.get(appName) || new Map();
      app.fields.forEach((field, key) => fields.set(key, field));
      this.appFields.set(appName, fields);
      for (const [datasetKey, datasetFields] of app.datasetFields) {
        const datasetId = `ds:${datasetKey}`;
        if (!this.datasetFields.has(datasetId)) this.datasetFields.set(datasetId, new Map());
        datasetFields.forEach((field, key) => this.datasetFields.get(datasetId).set(key, field));
      }
      for (const output of outputs) {
        const datasetId = `ds:${output.toUpperCase()}`;
        if (!this.datasetFields.has(datasetId)) this.datasetFields.set(datasetId, new Map());
        fields.forEach((field, key) => this.datasetFields.get(datasetId).set(key, field));
      }
      const summaries = { ...existingApp?.details?.summaries, 'qlik-io-csv': summary };
      this.apps.set(appName, {
        name: appName,
        scriptLength: existingApp?.scriptLength || 0,
        rawScriptSnippet: this.composeSnippet(existingApp, summaries),
        fullScript: existingApp?.fullScript || '',
        inputs: mergeNames(existingApp?.inputs || [], inputs),
        outputs: mergeNames(existingApp?.outputs || [], outputs),
        fields: Array.from(fields.values()),
        details: {
          ...existingApp?.details,
          source: 'qlik-io-csv',
          appId: app.appId || existingApp?.details?.appId,
          stream: app.stream,
          lastReload: app.lastReload,
          upstreamApps: mergeNames(existingApp?.details?.upstreamApps || [], upstreamApps),
          includes: Array.from(app.includes),
          unresolved,
          summaries
        }
      });
    }

    return groupedApps.size;
  }

  async processZipFile(file) {
    if (typeof JSZip === 'undefined') {
      throw new Error("La librería JSZip no está disponible.");
    }
    const zip = await JSZip.loadAsync(file);
    const files = Object.keys(zip.files);

    const scriptFiles = files.filter(name => {
      const lower = name.toLowerCase();
      return lower.endsWith('loadscript.json') || lower.endsWith('.qvs') || lower.endsWith('.txt');
    });

    // También buscar posibles archivos .qvd dentro del zip para extraer metadatos
    const qvdFiles = files.filter(name => name.toLowerCase().endsWith('.qvd'));
    for (const qf of qvdFiles.slice(0, 20)) {
      try {
        const text = await zip.files[qf].async('text');
        const endTag = '</QvdTableHeader>';
        const endIdx = text.indexOf(endTag);
        if (endIdx !== -1) {
          const headerXml = text.slice(0, endIdx + endTag.length);
          this.parseQvdHeader(qf.split('/').pop(), headerXml);
        }
      } catch (err) {
        // Ignorar si el qvd es binario estricto no decodificable como texto directo
      }
    }

    let loadedCount = 0;

    // Archivos .qvf (apps Qlik Sense binarias): extracción best-effort del script
    const qvfFiles = files.filter(name => name.toLowerCase().endsWith('.qvf'));
    for (const qf of qvfFiles) {
      const entry = zip.files[qf];
      if (entry.dir) continue;
      try {
        const buffer = await entry.async('arraybuffer');
        const extractedText = this.extractScriptFromQvfBuffer(buffer);
        const appName = qf.split('/').pop().replace(/\.[^/.]+$/, '');
        this.parseAppScript(appName, extractedText);
        loadedCount++;
      } catch (err) {
        console.warn(`Error leyendo QVF ${qf} dentro del zip:`, err);
      }
    }

    if (scriptFiles.length === 0 && qvdFiles.length === 0 && qvfFiles.length === 0) {
      throw new Error(`No se encontraron scripts, QVDs ni QVFs en el ZIP "${file.name}".`);
    }

    for (const filePath of scriptFiles) {
      const entry = zip.files[filePath];
      if (entry.dir) continue;

      const content = await entry.async('string');
      let appName = '';

      const parts = filePath.split('/');
      if (parts.length > 1) {
        appName = parts[0];
      } else {
        appName = file.name.replace(/\.[^/.]+$/, '');
        if (parts[0].toLowerCase() !== 'loadscript.json') {
          appName += ` (${parts[0]})`;
        }
      }

      if (filePath.toLowerCase().endsWith('.json')) {
        this.processLoadscriptJson(appName, content);
      } else {
        this.parseAppScript(appName, content);
      }
      loadedCount++;
    }

    return loadedCount;
  }

  async processFileList(fileList) {
    let count = 0;
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const relPath = file.webkitRelativePath || file.name;
      const lower = relPath.toLowerCase();

      if (lower.endsWith('.csv')) {
        try {
          const text = await file.text();
          count += this.processQlikCsv(text, file.name.replace(/\.[^/.]+$/, ''));
        } catch (err) {
          console.warn(`Error procesando CSV ${relPath}:`, err);
        }
        continue;
      }

      if (lower.endsWith('.zip')) {
        try {
          await this.processZipFile(file);
          count++;
        } catch (err) {
          console.warn(`Error procesando zip ${relPath}:`, err);
        }
        continue;
      }

      // Si es un archivo .qvd directo
      if (lower.endsWith('.qvd')) {
        try {
          const slice = file.slice(0, 512 * 1024); // Leer primeros 512 KB
          const text = await slice.text();
          const endTag = '</QvdTableHeader>';
          const endIdx = text.indexOf(endTag);
          if (endIdx !== -1) {
            this.parseQvdHeader(file.name, text.slice(0, endIdx + endTag.length));
            count++;
          }
        } catch (err) {
          console.warn(`Error leyendo cabecera QVD ${file.name}:`, err);
        }
        continue;
      }

      // Si es una app Qlik Sense binaria (.qvf): extracción best-effort del script embebido
      if (lower.endsWith('.qvf')) {
        try {
          const extractedText = await this.extractScriptFromQvfFile(file);
          const appName = file.name.replace(/\.[^/.]+$/, '');
          this.parseAppScript(appName, extractedText);
          count++;
        } catch (err) {
          console.warn(`Error leyendo QVF ${relPath}:`, err);
        }
        continue;
      }

      if (lower.endsWith('loadscript.json') || lower.endsWith('.qvs') || (lower.endsWith('.txt') && lower.includes('script'))) {
        const text = await file.text();
        const parts = relPath.split(/[\/\\]/);
        let appName = '';

        if (lower.endsWith('loadscript.json')) {
          appName = parts.length > 1 ? parts[parts.length - 2] : file.name.replace(/\.[^/.]+$/, '');
          this.processLoadscriptJson(appName, text);
        } else {
          appName = file.name.replace(/\.[^/.]+$/, '');
          this.parseAppScript(appName, text);
        }
        count++;
      }
    }
    return count;
  }

  buildGraph() {
    this.datasets.clear();
    this.links = [];
    this.fieldJourneyMap.clear();

    // 1. Recopilar todos los datasets
    for (const [appName, app] of this.apps.entries()) {
      for (const outName of app.outputs) {
        const datasetId = `ds:${outName.toUpperCase()}`;
        if (!this.datasets.has(datasetId)) {
          this.datasets.set(datasetId, {
            id: datasetId,
            name: outName,
            type: this.classifyDataset(outName),
            producers: new Set(),
            consumers: new Set()
          });
        }
        this.datasets.get(datasetId).producers.add(appName);
      }

      for (const inName of app.inputs) {
        const datasetId = `ds:${inName.toUpperCase()}`;
        if (!this.datasets.has(datasetId)) {
          this.datasets.set(datasetId, {
            id: datasetId,
            name: inName,
            type: this.classifyDataset(inName),
            producers: new Set(),
            consumers: new Set()
          });
        }
        this.datasets.get(datasetId).consumers.add(appName);
      }
    }

    // 2. Construir nodos para D3
    const nodes = [];
    const nodeIdMap = new Map();

    // Nodos de Apps
    for (const [appName, app] of this.apps.entries()) {
      const appId = `app:${appName}`;
      const fields = Array.from(this.appFields.get(appName)?.values() || []);
      const normalizedName = appName.trim().toUpperCase();
      const nodeType = normalizedName.startsWith('STG_') ? 'STG'
        : normalizedName.startsWith('DATA_') ? 'DATA'
          : 'APP';
      const node = {
        id: appId,
        name: appName,
        type: nodeType,
        nodeRole: 'APP',
        dataSource: app.details?.source || '',
        inputsCount: app.inputs.length,
        outputsCount: app.outputs.length,
        inputs: app.inputs,
        outputs: app.outputs,
        upstreamApps: app.details?.upstreamApps || [],
        downstreamApps: [],
        fields,
        fieldsCount: fields.length,
        snippet: app.rawScriptSnippet,
        fullScript: app.fullScript || '',
        radius: Math.min(26, 14 + (app.inputs.length + app.outputs.length) * 1.2)
      };
      nodes.push(node);
      nodeIdMap.set(appId, node);
    }

    const appNodeByName = new Map(Array.from(nodeIdMap.values())
      .filter(node => node.nodeRole === 'APP')
      .map(node => [node.name, node]));
    for (const [appName, app] of this.apps.entries()) {
      const targetId = `app:${appName}`;
      const targetNode = nodeIdMap.get(targetId);
      for (const upstreamName of app.details?.upstreamApps || []) {
        const sourceNode = appNodeByName.get(upstreamName);
        if (!sourceNode || sourceNode.id === targetId) continue;
        sourceNode.downstreamApps.push(appName);
        this.links.push({
          id: `${sourceNode.id}->${targetId}`,
          source: sourceNode.id,
          target: targetId,
          type: 'depends-on',
          label: 'DEPENDE'
        });
      }
    }

    // Nodos de Datasets
    for (const [dsId, ds] of this.datasets.entries()) {
      const producers = Array.from(ds.producers);
      const consumers = Array.from(ds.consumers);
      const totalDegrees = producers.length + consumers.length;
      const fields = Array.from(this.datasetFields.get(dsId)?.values() || []);

      const node = {
        id: dsId,
        name: ds.name,
        type: ds.type,
        producers,
        consumers,
        fields,
        fieldsCount: fields.length,
        isOrphan: producers.length === 0 && consumers.length === 0,
        isUnconsumed: producers.length > 0 && consumers.length === 0,
        isMissingProducer: producers.length === 0 && consumers.length > 0,
        radius: Math.min(20, 10 + totalDegrees * 1.4)
      };
      nodes.push(node);
      nodeIdMap.set(dsId, node);
    }

    // 3. Construir Enlaces
    for (const [dsId, ds] of this.datasets.entries()) {
      for (const prodApp of ds.producers) {
        const appId = `app:${prodApp}`;
        if (nodeIdMap.has(appId)) {
          this.links.push({
            id: `${appId}->${dsId}`,
            source: appId,
            target: dsId,
            type: 'produces',
            label: this.apps.get(prodApp)?.details?.source === 'qlik-model-csv' ? 'MODELO' : 'STORE'
          });
        }
      }

      for (const consApp of ds.consumers) {
        const appId = `app:${consApp}`;
        if (nodeIdMap.has(appId)) {
          this.links.push({
            id: `${dsId}->${appId}`,
            source: dsId,
            target: appId,
            type: 'consumes',
            label: this.apps.get(consApp)?.details?.source === 'qlik-model-csv' ? 'MODELO' : 'FROM'
          });
        }
      }
    }

    // 4. Construir Mapa de Linaje de Campos (Field Journey Map)
    for (const node of nodes) {
      if (!node.fields) continue;
      for (const f of node.fields) {
        const key = f.name.toLowerCase();
        if (!this.fieldJourneyMap.has(key)) {
          this.fieldJourneyMap.set(key, {
            name: f.name,
            originalExpr: f.originalExpr,
            nodeIds: new Set(),
            steps: []
          });
        }
        const record = this.fieldJourneyMap.get(key);
        record.nodeIds.add(node.id);
        record.steps.push({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          fieldInfo: f
        });
      }
    }

    const stats = {
      totalApps: nodes.filter(node => node.type === 'APP').length,
      totalDatasets: this.datasets.size,
      totalStg: nodes.filter(node => node.type === 'STG').length,
      totalData: nodes.filter(node => node.type === 'DATA').length,
      totalOther: nodes.filter(node => node.type === 'FUENTE' || node.type === 'QVD').length,
      totalFields: this.fieldJourneyMap.size,
      totalLinks: this.links.length,
      unconsumedCount: Array.from(this.datasets.values()).filter(d => d.producers.size > 0 && d.consumers.size === 0).length,
      missingProducerCount: Array.from(this.datasets.values()).filter(d => d.producers.size === 0 && d.consumers.size > 0).length
    };

    return { nodes, links: this.links, stats };
  }

  /**
   * Obtiene el recorrido completo de un campo específico a través de todo el grafo
   */
  getFieldJourney(fieldName) {
    if (!fieldName) return null;
    const key = fieldName.toLowerCase().trim();
    return this.fieldJourneyMap.get(key) || null;
  }

  /**
   * Retorna una lista de todos los campos descubiertos con su frecuencia
   */
  getAllFields() {
    const list = [];
    for (const [key, val] of this.fieldJourneyMap.entries()) {
      list.push({
        key,
        name: val.name,
        occurrences: val.nodeIds.size,
        steps: val.steps
      });
    }
    return list.sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name));
  }

  exportProject(projectName = 'Proyecto Linaje') {
    const graphData = this.buildGraph();
    return {
      version: '1.1.0',
      appName: 'Linaje Qlik Brain',
      projectName,
      exportDate: new Date().toISOString(),
      apps: Array.from(this.apps.entries()).map(([k, v]) => ({
        name: k,
        inputs: v.inputs,
        outputs: v.outputs,
        details: v.details,
        snippet: v.rawScriptSnippet,
        fullScript: v.fullScript || '',
        fields: v.fields
      })),
      datasetFields: Array.from(this.datasetFields.entries()).map(([k, v]) => ({
        datasetId: k,
        fields: Array.from(v.values())
      })),
      fieldJourneys: this.getAllFields(),
      graph: {
        nodes: graphData.nodes,
        links: graphData.links,
        stats: graphData.stats
      }
    };
  }

  importProject(projectData) {
    this.reset();
    if (!projectData || !projectData.apps) {
      throw new Error("El archivo no tiene el formato de proyecto de Linaje válido.");
    }

    if (projectData.datasetFields && Array.isArray(projectData.datasetFields)) {
      for (const item of projectData.datasetFields) {
        const map = new Map();
        if (Array.isArray(item.fields)) {
          item.fields.forEach(f => map.set(f.name.toLowerCase(), f));
        }
        this.datasetFields.set(item.datasetId, map);
      }
    }

    for (const app of projectData.apps) {
      const appFieldMap = new Map();
      if (app.fields && Array.isArray(app.fields)) {
        app.fields.forEach(f => appFieldMap.set(f.name.toLowerCase(), f));
      }
      this.appFields.set(app.name, appFieldMap);

      this.apps.set(app.name, {
        name: app.name,
        scriptLength: (app.snippet || '').length,
        rawScriptSnippet: app.snippet || '',
        fullScript: app.fullScript || app.snippet || '',
        inputs: app.inputs || [],
        outputs: app.outputs || [],
        fields: app.fields || [],
        details: app.details || { rawInputs: [], rawOutputs: [] }
      });
    }

    return this.buildGraph();
  }
}

window.QlikLineageParser = QlikLineageParser;
