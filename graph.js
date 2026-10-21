/**
 * Linaje - Visualizador de Grafo Estilo Obsidian Brain & Flujo Jerárquico
 * Motor de física de fuerzas (D3 force) sobre Canvas de alto rendimiento
 * Soporta ordenación Izquierda ➔ Derecha (Linaje DAG), zoom, pan, partículas y resaltado.
 */

class ObsidianGraph {
  constructor(canvasContainer, onNodeSelect) {
    this.container = canvasContainer;
    this.onNodeSelect = onNodeSelect;

    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.container.appendChild(this.canvas);

    this.width = this.container.clientWidth || 800;
    this.height = this.container.clientHeight || 600;

    // Modo de disposición: 'lr' (Izquierda a Derecha) o 'radial' (Libre)
    this.layoutMode = 'lr';

    // Colores por categoría (Estética Obsidian Cyber)
    this.colors = {
      APP: { fill: '#38bdf8', glow: 'rgba(56, 189, 248, 0.45)', text: '#bae6fd', border: '#0284c7' },
      STG: { fill: '#fbbf24', glow: 'rgba(251, 191, 36, 0.45)', text: '#fef08a', border: '#d97706' },
      DATA: { fill: '#34d399', glow: 'rgba(52, 211, 153, 0.45)', text: '#a7f3d0', border: '#059669' },
      FUENTE: { fill: '#c084fc', glow: 'rgba(192, 132, 252, 0.45)', text: '#e9d5ff', border: '#9333ea' },
      QVD: { fill: '#f472b6', glow: 'rgba(244, 114, 182, 0.45)', text: '#fbcfe8', border: '#db2777' },
      LINK_PRODUCES: 'rgba(56, 189, 248, 0.45)',
      LINK_CONSUMES: 'rgba(52, 211, 153, 0.45)',
      LINK_UPSTREAM: '#38bdf8',
      LINK_DOWNSTREAM: '#34d399',
      LINK_DIMMED: 'rgba(255, 255, 255, 0.04)',
      BG: '#0b0f19'
    };

    // Parámetros de física configurables
    this.physics = {
      linkDistance: 85,
      chargeStrength: -260,
      collisionRadius: 24,
      centerStrength: 0.08,
      horizontalStrength: 0.65, // Fuerza para atraer al carril Izquierda-Derecha
      verticalStrength: 0.09,
      showParticles: true,
      showLabels: true,
      useCurves: true,
      particleSpeed: 0.007
    };

    // Estado interno
    this.nodes = [];
    this.links = [];
    this.particles = [];
    this.selectedNode = null;
    this.selectedNodeIds = new Set();
    this.hoveredNode = null;
    this.connectedNodeIds = new Set();
    this.upstreamLinkIds = new Set();
    this.downstreamLinkIds = new Set();

    // Linaje de campos (Column Tracking)
    this.trackedFieldName = null;
    this.trackedNodeIds = new Set();
    this.trackedLinkIds = new Set();

    // Filtros activos
    this.filters = {
      APP: true,
      STG: true,
      DATA: true,
      FUENTE: true,
      QVD: true,
      hideOrphans: false,
      searchQuery: ''
    };
    this.selectedAppIds = null;

    // Transformación de cámara (Zoom & Pan)
    this.transform = d3.zoomIdentity;
    this.initZoom();
    this.initEvents();
    this.resize();

    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.width = this.container.clientWidth || 800;
    this.height = this.container.clientHeight || 600;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.scale(dpr, dpr);
    if (this.simulation) {
      this.recalculateTargetPositions();
      this.simulation.alpha(0.3).restart();
    }
  }

  initZoom() {
    this.zoom = d3.zoom()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => {
        this.transform = event.transform;
      });

    d3.select(this.canvas).call(this.zoom);
  }

  initEvents() {
    const canvas = this.canvas;

    d3.select(canvas).call(
      d3.drag()
        .container(canvas)
        .subject(event => {
          const [x, y] = this.transform.invert([event.x, event.y]);
          return this.findNodeAt(x, y);
        })
        .on('start', (event) => {
          if (!event.active && this.simulation) this.simulation.alphaTarget(0.3).restart();
          event.subject.fx = event.subject.x;
          event.subject.fy = event.subject.y;
        })
        .on('drag', (event) => {
          event.subject.fx = event.x;
          event.subject.fy = event.y;
        })
        .on('end', (event) => {
          if (!event.active && this.simulation) this.simulation.alphaTarget(0);
          event.subject.fx = null;
          event.subject.fy = null;
        })
    );

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const [worldX, worldY] = this.transform.invert([mouseX, mouseY]);
      const found = this.findNodeAt(worldX, worldY);

      if (found !== this.hoveredNode) {
        this.hoveredNode = found;
        canvas.style.cursor = found ? 'pointer' : 'default';
      }
    });

    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const [worldX, worldY] = this.transform.invert([mouseX, mouseY]);
      const found = this.findNodeAt(worldX, worldY);

      if (found && (e.ctrlKey || e.metaKey || e.shiftKey)) {
        this.toggleNodeSelection(found);
      } else {
        this.selectNode(found);
      }
    });
  }

  findNodeAt(x, y) {
    const visibleNodes = this.getFilteredNodes();
    for (let i = visibleNodes.length - 1; i >= 0; i--) {
      const node = visibleNodes[i];
      const dx = x - node.x;
      const dy = y - node.y;
      const r = (node.radius || 12) + 4;
      if (dx * dx + dy * dy <= r * r) {
        return node;
      }
    }
    return null;
  }

  /** Calcula capas izquierda-derecha y reserva una capa final para las hojas conectadas. */
  computeLineageRanks(nodes, links) {
    const inEdges = new Map(nodes.map(n => [n.id, []]));
    const outEdges = new Map(nodes.map(n => [n.id, []]));

    for (const l of links) {
      const sId = typeof l.source === 'object' ? l.source.id : l.source;
      const tId = typeof l.target === 'object' ? l.target.id : l.target;
      if (outEdges.has(sId)) outEdges.get(sId).push(tId);
      if (inEdges.has(tId)) inEdges.get(tId).push(sId);
    }

    let nextIndex = 0;
    const indexes = new Map();
    const lowLinks = new Map();
    const stack = [];
    const stacked = new Set();
    const components = [];

    const visit = nodeId => {
      indexes.set(nodeId, nextIndex);
      lowLinks.set(nodeId, nextIndex);
      nextIndex++;
      stack.push(nodeId);
      stacked.add(nodeId);

      for (const targetId of outEdges.get(nodeId) || []) {
        if (!indexes.has(targetId)) {
          visit(targetId);
          lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId), lowLinks.get(targetId)));
        } else if (stacked.has(targetId)) {
          lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId), indexes.get(targetId)));
        }
      }

      if (lowLinks.get(nodeId) === indexes.get(nodeId)) {
        const component = [];
        let memberId;
        do {
          memberId = stack.pop();
          stacked.delete(memberId);
          component.push(memberId);
        } while (memberId !== nodeId);
        components.push(component);
      }
    };

    for (const node of nodes) {
      if (!indexes.has(node.id)) visit(node.id);
    }

    const componentByNode = new Map();
    components.forEach((component, componentIndex) => {
      component.forEach(nodeId => componentByNode.set(nodeId, componentIndex));
    });

    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const stageRank = node => {
      const name = (node.name || '').trim().toUpperCase();
      if (node.type === 'APP' && name.startsWith('DATA_')) return 1;
      if (node.type === 'APP' && name.startsWith('STG_')) return 2;
      if (node.type === 'APP') return 3;
      if (node.type === 'STG') return 2;
      if (node.type === 'DATA') return 1;
      return 0;
    };
    const componentBaseRanks = components.map(component => Math.max(
      ...component.map(nodeId => stageRank(nodeById.get(nodeId)))
    ));

    const componentOut = components.map(() => new Set());
    const componentInDegree = components.map(() => 0);
    for (const [sourceId, targets] of outEdges) {
      const sourceComponent = componentByNode.get(sourceId);
      for (const targetId of targets) {
        const targetComponent = componentByNode.get(targetId);
        if (sourceComponent !== targetComponent && !componentOut[sourceComponent].has(targetComponent)) {
          componentOut[sourceComponent].add(targetComponent);
          componentInDegree[targetComponent]++;
        }
      }
    }

    const pendingInDegree = [...componentInDegree];
  const componentRanks = [...componentBaseRanks];
    const ready = pendingInDegree
      .map((degree, componentIndex) => degree === 0 ? componentIndex : -1)
      .filter(componentIndex => componentIndex !== -1);

    while (ready.length > 0) {
      const sourceComponent = ready.shift();
      for (const targetComponent of componentOut[sourceComponent]) {
        componentRanks[targetComponent] = Math.max(
          componentRanks[targetComponent],
          componentBaseRanks[targetComponent],
          componentRanks[sourceComponent] + 1
        );
        pendingInDegree[targetComponent]--;
        if (pendingInDegree[targetComponent] === 0) ready.push(targetComponent);
      }
    }

    const terminalComponents = new Set();
    let maxIntermediateRank = 0;
    components.forEach((component, componentIndex) => {
      const isStageApp = component.some(nodeId => {
        const node = nodeById.get(nodeId);
        return node.nodeRole === 'APP' && (node.type === 'DATA' || node.type === 'STG');
      });
      if (componentOut[componentIndex].size === 0 && componentInDegree[componentIndex] > 0 && !isStageApp) {
        terminalComponents.add(componentIndex);
      } else {
        maxIntermediateRank = Math.max(maxIntermediateRank, componentRanks[componentIndex]);
      }
    });

    const terminalRank = maxIntermediateRank + 1;
    for (const node of nodes) {
      const componentIndex = componentByNode.get(node.id);
      node.isSource = (inEdges.get(node.id) || []).length === 0;
      node.isTerminal = terminalComponents.has(componentIndex);
      node.rank = node.isTerminal ? terminalRank : componentRanks[componentIndex];
    }

    this.maxRank = Math.max(...nodes.map(node => node.rank || 0), 1);
    return this.maxRank;
  }

  recalculateTargetPositions() {
    if (!this.nodes || this.nodes.length === 0) return;
    const maxRank = this.maxRank || 1;
    const paddingX = Math.min(90, this.width * 0.12);
    const usableWidth = Math.max(this.width - paddingX * 2, 40);

    this.nodes.forEach(node => {
      const rank = node.rank || 0;
      node.targetX = paddingX + (rank / maxRank) * usableWidth;

      // Si no tiene posición asignada, inicializarla cerca de su carril
      if (node.x === undefined || isNaN(node.x)) {
        node.x = node.targetX + (Math.random() - 0.5) * 50;
        node.y = this.height / 2 + (Math.random() - 0.5) * (this.height * 0.6);
      }
    });
  }

  toggleNodeSelection(node) {
    if (this.selectedNodeIds.has(node.id)) {
      this.selectedNodeIds.delete(node.id);
      const nextNode = this.selectedNode?.id === node.id
        ? this.nodes.find(candidate => this.selectedNodeIds.has(candidate.id)) || null
        : this.selectedNode;
      this.selectNode(nextNode, true);
      return;
    }

    this.selectedNodeIds.add(node.id);
    this.selectNode(node, true);
  }

  selectNode(node, preserveSelection = false) {
    if (!preserveSelection) {
      this.selectedNodeIds = new Set(node ? [node.id] : []);
    }
    this.selectedNode = node;
    this.connectedNodeIds.clear();
    this.upstreamLinkIds.clear();
    this.downstreamLinkIds.clear();
    // Clear field tracking when a node is clicked
    this.trackedFieldName = null;
    this.trackedNodeIds.clear();
    this.trackedLinkIds.clear();

    if (node) {
      this.connectedNodeIds.add(node.id);

      // 1. Upstream
      for (const link of this.links) {
        const sId = typeof link.source === 'object' ? link.source.id : link.source;
        const tId = typeof link.target === 'object' ? link.target.id : link.target;
        if (tId === node.id) {
          this.connectedNodeIds.add(sId);
          this.upstreamLinkIds.add(link.id);
        }
      }

      // 2. Downstream
      for (const link of this.links) {
        const sId = typeof link.source === 'object' ? link.source.id : link.source;
        const tId = typeof link.target === 'object' ? link.target.id : link.target;
        if (sId === node.id) {
          this.connectedNodeIds.add(tId);
          this.downstreamLinkIds.add(link.id);
        }
      }

      // 3. Cadena extendida
      for (const link of this.links) {
        const sId = typeof link.source === 'object' ? link.source.id : link.source;
        const tId = typeof link.target === 'object' ? link.target.id : link.target;
        if (this.connectedNodeIds.has(sId) && !this.connectedNodeIds.has(tId)) {
          this.connectedNodeIds.add(tId);
          this.downstreamLinkIds.add(link.id);
        } else if (this.connectedNodeIds.has(tId) && !this.connectedNodeIds.has(sId)) {
          this.connectedNodeIds.add(sId);
          this.upstreamLinkIds.add(link.id);
        }
      }
    }

    if (this.onNodeSelect) {
      this.onNodeSelect(node);
    }
  }

  /**
   * Activa el seguimiento de un campo específico a través de todos los nodos.
   * Resalta con un halo dorado todos los nodos/datasets donde existe ese campo.
   * Los enlaces que conectan esos nodos también se resaltan.
   */
  trackField(fieldName, nodeIds) {
    this.trackedFieldName = fieldName;
    this.trackedNodeIds = new Set(nodeIds || []);
    this.trackedLinkIds.clear();
    // Resaltar enlaces entre nodos que comparten el campo
    for (const link of this.links) {
      const sId = typeof link.source === 'object' ? link.source.id : link.source;
      const tId = typeof link.target === 'object' ? link.target.id : link.target;
      if (this.trackedNodeIds.has(sId) && this.trackedNodeIds.has(tId)) {
        this.trackedLinkIds.add(link.id);
      }
    }
    // Clear node selection when tracking a field
    this.selectedNode = null;
    this.selectedNodeIds.clear();
    this.connectedNodeIds.clear();
    this.upstreamLinkIds.clear();
    this.downstreamLinkIds.clear();
    if (this.onNodeSelect) this.onNodeSelect(null);
  }

  clearFieldTracking() {
    this.trackedFieldName = null;
    this.trackedNodeIds.clear();
    this.trackedLinkIds.clear();
  }

  setData(nodes, links) {
    this.rawNodes = nodes;
    this.rawLinks = links;

    this.updateGraphData();
    this.startLoop();
    this.resetZoom();
  }

  setSelectedApps(appIds) {
    this.selectedAppIds = appIds === null ? null : new Set(appIds);
    this.updateGraphData();
    this.resetZoom();
  }

  updateGraphData() {
    const filteredNodes = this.getFilteredNodes();
    const visibleNodeIdSet = new Set(filteredNodes.map(n => n.id));

    // Filtrar enlaces cuyos dos extremos estén visibles
    const filteredLinks = this.rawLinks.filter(l => {
      const sId = typeof l.source === 'object' ? l.source.id : l.source;
      const tId = typeof l.target === 'object' ? l.target.id : l.target;
      return visibleNodeIdSet.has(sId) && visibleNodeIdSet.has(tId);
    }).map(l => ({
      ...l,
      source: typeof l.source === 'object' ? l.source.id : l.source,
      target: typeof l.target === 'object' ? l.target.id : l.target
    }));

    this.nodes = filteredNodes;
    this.links = filteredLinks;

    // Calcular jerarquía topológica de Izquierda a Derecha
    this.computeLineageRanks(this.nodes, this.links);
    this.recalculateTargetPositions();

    // Crear partículas para animación de flujo
    this.particles = [];
    if (this.physics.showParticles) {
      for (let i = 0; i < this.links.length; i++) {
        this.particles.push({
          linkIndex: i,
          progress: Math.random(),
          speed: this.physics.particleSpeed * (0.8 + Math.random() * 0.5)
        });
      }
    }

    // Configurar simulación D3 Force
    if (this.simulation) {
      this.simulation.stop();
    }

    this.simulation = d3.forceSimulation(this.nodes);

    if (this.layoutMode === 'lr') {
      // Modo Flujo Izquierda ➔ Derecha
      this.simulation
        .force('x', d3.forceX(d => d.targetX).strength(this.physics.horizontalStrength))
        .force('y', d3.forceY(this.height / 2).strength(this.physics.verticalStrength))
        .force('link', d3.forceLink(this.links).id(d => d.id).distance(this.physics.linkDistance).strength(0.7))
        .force('charge', d3.forceManyBody().strength(this.physics.chargeStrength).distanceMax(600))
        .force('collision', d3.forceCollide().radius(d => (d.radius || 12) + this.physics.collisionRadius))
        .force('center', null);
    } else {
      // Modo Radial Libre (Obsidian clásico)
      this.simulation
        .force('link', d3.forceLink(this.links).id(d => d.id).distance(this.physics.linkDistance))
        .force('charge', d3.forceManyBody().strength(this.physics.chargeStrength).distanceMax(500))
        .force('collision', d3.forceCollide().radius(d => (d.radius || 12) + this.physics.collisionRadius))
        .force('center', d3.forceCenter(this.width / 2, this.height / 2).strength(this.physics.centerStrength));
    }

    this.simulation.alpha(0.8).restart();
  }

  setLayoutMode(mode) {
    this.layoutMode = mode;
    this.updateGraphData();
  }

  getFilteredNodes() {
    if (!this.rawNodes) return [];
    let appScope = null;
    if (this.selectedAppIds !== null) {
      appScope = new Set();
      const nodeById = new Map(this.rawNodes.map(node => [node.id, node]));
      const pending = [...this.selectedAppIds];
      while (pending.length > 0) {
        const targetId = pending.pop();
        if (appScope.has(targetId)) continue;
        const targetNode = nodeById.get(targetId);
        if (!targetNode || targetNode.type === 'MODEL') continue;
        appScope.add(targetId);

        for (const link of this.rawLinks) {
          const linkTargetId = typeof link.target === 'object' ? link.target.id : link.target;
          if (linkTargetId !== targetId) continue;
          const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
          const sourceNode = nodeById.get(sourceId);
          if (sourceNode && sourceNode.type !== 'MODEL' && !appScope.has(sourceId)) pending.push(sourceId);
        }
      }
    }

    return this.rawNodes.filter(node => {
      if (!this.filters[node.type]) return false;
      if (appScope && !appScope.has(node.id)) return false;
      if (this.filters.hideOrphans && node.isOrphan) return false;
      if (this.filters.searchQuery) {
        const query = this.filters.searchQuery.toLowerCase();
        if (!node.name.toLowerCase().includes(query)) return false;
      }
      return true;
    });
  }

  startLoop() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }

    const render = () => {
      this.draw();
      this.animationFrameId = requestAnimationFrame(render);
    };

    this.animationFrameId = requestAnimationFrame(render);
  }

  draw() {
    const ctx = this.ctx;
    ctx.save();
    ctx.clearRect(0, 0, this.width, this.height);

    // Fondo Obsidian
    ctx.fillStyle = this.colors.BG;
    ctx.fillRect(0, 0, this.width, this.height);

    // Cámara (Zoom y Pan)
    ctx.translate(this.transform.x, this.transform.y);
    ctx.scale(this.transform.k, this.transform.k);

    const hasSelection = this.selectedNode !== null;

    const hasFieldTracking = this.trackedNodeIds.size > 0;

    // 1. Dibujar Enlaces (Curvas de flujo Izquierda -> Derecha)
    for (let i = 0; i < this.links.length; i++) {
      const link = this.links[i];
      const source = link.source;
      const target = link.target;
      if (!source || !target || source.x === undefined || target.x === undefined) continue;

      const isUpstream = this.upstreamLinkIds.has(link.id);
      const isDownstream = this.downstreamLinkIds.has(link.id);
      const isFieldLink = hasFieldTracking && this.trackedLinkIds.has(link.id);
      const isConnected = (!hasSelection && !hasFieldTracking) || isUpstream || isDownstream || isFieldLink;

      ctx.beginPath();
      ctx.moveTo(source.x, source.y);

      // Si estamos en modo Izquierda-Derecha y usamos curvas Bezier elegantes
      if (this.physics.useCurves && Math.abs(target.x - source.x) > 20) {
        const midX = (source.x + target.x) / 2;
        ctx.bezierCurveTo(midX, source.y, midX, target.y, target.x, target.y);
      } else {
        ctx.lineTo(target.x, target.y);
      }

      if (isConnected) {
        if (isFieldLink) {
          ctx.strokeStyle = 'rgba(251, 191, 36, 0.7)';
          ctx.lineWidth = 2.5;
        } else if (hasSelection) {
          ctx.strokeStyle = isUpstream ? this.colors.LINK_UPSTREAM : this.colors.LINK_DOWNSTREAM;
          ctx.lineWidth = 2.8;
        } else {
          ctx.strokeStyle = link.type === 'produces' ? this.colors.LINK_PRODUCES : this.colors.LINK_CONSUMES;
          ctx.lineWidth = 1.4;
        }
      } else {
        ctx.strokeStyle = this.colors.LINK_DIMMED;
        ctx.lineWidth = 0.8;
      }
      ctx.stroke();

      // Flechas indicadoras de dirección del flujo
      if (isConnected && this.transform.k > 0.4) {
        this.drawArrow(ctx, source.x, source.y, target.x, target.y, target.radius || 12, ctx.strokeStyle);
      }
    }

    // 2. Partículas de flujo que viajan a través de los enlaces
    if (this.physics.showParticles && (!hasSelection || this.upstreamLinkIds.size > 0 || this.downstreamLinkIds.size > 0 || hasFieldTracking)) {
      for (const p of this.particles) {
        const link = this.links[p.linkIndex];
        if (!link || !link.source || !link.target) continue;

        const isFieldP = hasFieldTracking && this.trackedLinkIds.has(link.id);
        if (hasSelection && !this.upstreamLinkIds.has(link.id) && !this.downstreamLinkIds.has(link.id)) continue;
        if (hasFieldTracking && !isFieldP) continue;

        p.progress += p.speed;
        if (p.progress > 1) p.progress = 0;

        let px, py;
        if (this.physics.useCurves && Math.abs(link.target.x - link.source.x) > 20) {
          const t = p.progress;
          const midX = (link.source.x + link.target.x) / 2;
          // Curva Bezier cúbica B(t)
          const mt = 1 - t;
          px = mt*mt*mt*link.source.x + 3*mt*mt*t*midX + 3*mt*t*t*midX + t*t*t*link.target.x;
          py = mt*mt*mt*link.source.y + 3*mt*mt*t*link.source.y + 3*mt*t*t*link.target.y + t*t*t*link.target.y;
        } else {
          px = link.source.x + (link.target.x - link.source.x) * p.progress;
          py = link.source.y + (link.target.y - link.source.y) * p.progress;
        }

        ctx.beginPath();
        ctx.arc(px, py, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = link.type === 'produces' ? '#38bdf8' : '#34d399';
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = 6;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    // 3. Dibujar Nodos
    const fieldPulse = (Date.now() % 1600) / 1600;
    const fieldGlowAlpha = 0.25 + 0.4 * Math.abs(Math.sin(fieldPulse * Math.PI));

    for (const node of this.nodes) {
      if (node.x === undefined || node.y === undefined) continue;

      const isSelected = this.selectedNodeIds.has(node.id) ||
        (this.selectedNode && this.selectedNode.id === node.id);
      const isConnected = !hasSelection || this.connectedNodeIds.has(node.id) || this.selectedNodeIds.has(node.id);
      const isHovered = this.hoveredNode && this.hoveredNode.id === node.id;
      const isFieldTracked = hasFieldTracking && this.trackedNodeIds.has(node.id);
      const isFieldDimmed = hasFieldTracking && !isFieldTracked;

      const style = this.colors[node.type] || this.colors.FUENTE;
      const r = node.radius || 12;

      ctx.save();
      ctx.translate(node.x, node.y);

      // Halo de Linaje de Campo: anillo dorado pulsante
      if (isFieldTracked) {
        ctx.beginPath();
        ctx.arc(0, 0, r + 13, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(251, 191, 36, ${fieldGlowAlpha})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0, r + 7, 0, Math.PI * 2);
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      // Resplandor Halo de selección
      if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(0, 0, r + 9, 0, Math.PI * 2);
        ctx.fillStyle = style.glow;
        ctx.fill();
      }

      // Círculo del nodo
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      if (isFieldDimmed) {
        ctx.fillStyle = 'rgba(75, 85, 99, 0.12)';
      } else if (isFieldTracked) {
        ctx.fillStyle = style.fill;
      } else {
        ctx.fillStyle = isConnected ? style.fill : 'rgba(75, 85, 99, 0.2)';
      }
      ctx.fill();

      ctx.lineWidth = isSelected ? 3.5 : isFieldTracked ? 3 : 1.6;
      ctx.strokeStyle = isFieldTracked ? '#fbbf24' : isConnected && !isFieldDimmed ? style.border : 'rgba(107, 114, 128, 0.2)';
      ctx.stroke();

      if (node.isTerminal && !isFieldDimmed) {
        ctx.beginPath();
        ctx.arc(0, 0, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }

      // Alerta de no consumido
      if (node.isUnconsumed && (isConnected || isFieldTracked)) {
        ctx.beginPath();
        ctx.arc(r - 3, -r + 3, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#f87171';
        ctx.fill();
      }

      ctx.restore();
    }

    // 4. Etiquetas de texto (con anti-solapamiento: se omiten las que chocarían con otra ya colocada)
    if (this.physics.showLabels) {
      this.drawLabels(ctx, hasSelection, hasFieldTracking);
    }

    ctx.restore();
  }

  /**
   * Coloca las etiquetas de texto evitando solapamientos entre sí (greedy placement).
   * Prioriza nodo seleccionado > hover > conectados/trazados > resto (por grado de conexión).
   */
  drawLabels(ctx, hasSelection, hasFieldTracking) {
    const candidates = [];
    for (const node of this.nodes) {
      if (node.x === undefined || node.y === undefined) continue;

      const isSelected = this.selectedNodeIds.has(node.id) ||
        (this.selectedNode && this.selectedNode.id === node.id);
      const isConnected = !hasSelection || this.connectedNodeIds.has(node.id) || this.selectedNodeIds.has(node.id);
      const isHovered = this.hoveredNode && this.hoveredNode.id === node.id;
      const isFieldTracked = hasFieldTracking && this.trackedNodeIds.has(node.id);
      const isFieldDimmed = hasFieldTracking && !isFieldTracked;

      const eligible = this.transform.k > 0.55 || isSelected || isHovered || isConnected;
      if (!eligible || isFieldDimmed) continue;

      let priority = 0;
      if (isSelected) priority = 4;
      else if (isHovered) priority = 3;
      else if (isFieldTracked) priority = 2;
      else if (hasSelection && isConnected) priority = 1;

      candidates.push({ node, isSelected, isConnected, isHovered, priority, style: this.colors[node.type] || this.colors.FUENTE });
    }

    // Prioridad primero, luego por grado (radio) descendente, para que los nodos importantes ganen el espacio
    candidates.sort((a, b) => b.priority - a.priority || (b.node.radius || 12) - (a.node.radius || 12));

    const placed = [];
    const intersects = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

    for (const c of candidates) {
      const node = c.node;
      const r = node.radius || 12;
      const isBold = c.isSelected;
      ctx.font = isBold ? 'bold 12px Inter, system-ui, sans-serif' : '11px Inter, system-ui, sans-serif';

      let displayName = node.name;
      if (displayName.length > 26 && !c.isSelected && !c.isHovered) {
        displayName = displayName.substring(0, 24) + '...';
      }

      const textWidth = ctx.measureText(displayName).width;
      const padX = 4, padY = 2;
      const labelH = node.isTerminal ? 26 : 14;
      const rect = {
        x0: node.x - textWidth / 2 - padX,
        x1: node.x + textWidth / 2 + padX,
        y0: node.y + r + 3,
        y1: node.y + r + 3 + labelH + padY
      };

      // Los nodos con prioridad (seleccionado/hover) siempre se muestran; el resto se omite si choca
      const collides = c.priority === 0 && placed.some(p => intersects(rect, p));
      if (collides) continue;
      placed.push(rect);

      // Fondo semitransparente para legibilidad sobre líneas/nodos
      ctx.fillStyle = 'rgba(11, 15, 25, 0.6)';
      ctx.fillRect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);

      ctx.fillStyle = c.isConnected ? (c.isSelected ? '#ffffff' : c.style.text) : 'rgba(156, 163, 175, 0.3)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(displayName, node.x, node.y + r + 5);
      if (node.isTerminal) {
        ctx.font = 'bold 8px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#fbbf24';
        ctx.fillText('FINAL', node.x, node.y + r + 17);
      }
    }
  }

  drawArrow(ctx, fromX, fromY, toX, toY, targetRadius, color) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return;

    const arrowDist = dist - targetRadius - 4;
    const arrowX = fromX + (dx / dist) * arrowDist;
    const arrowY = fromY + (dy / dist) * arrowDist;

    const angle = Math.atan2(dy, dx);
    const arrowSize = 6;

    ctx.save();
    ctx.translate(arrowX, arrowY);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-arrowSize * 1.5, -arrowSize);
    ctx.lineTo(-arrowSize * 1.5, arrowSize);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  zoomToNode(nodeId) {
    const node = this.nodes.find(n => n.id === nodeId);
    if (!node || node.x === undefined) return;

    this.selectNode(node);

    const targetX = this.width / 2 - node.x * 1.3;
    const targetY = this.height / 2 - node.y * 1.3;

    d3.select(this.canvas)
      .transition()
      .duration(750)
      .call(
        this.zoom.transform,
        d3.zoomIdentity.translate(targetX, targetY).scale(1.3)
      );
  }

  resetZoom() {
    if (!this.nodes || this.nodes.length === 0) return;

    // Calcular bounding box de los nodos para encajar la vista
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    this.nodes.forEach(n => {
      if (n.x !== undefined && n.y !== undefined) {
        if (n.x < minX) minX = n.x;
        if (n.x > maxX) maxX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.y > maxY) maxY = n.y;
      }
    });

    if (minX === Infinity) {
      minX = 0; maxX = this.width; minY = 0; maxY = this.height;
    }

    const boxWidth = maxX - minX + 160;
    const boxHeight = maxY - minY + 160;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    const scale = Math.max(0.2, Math.min(1.6, 0.85 / Math.max(boxWidth / this.width, boxHeight / this.height)));
    const tx = this.width / 2 - midX * scale;
    const ty = this.height / 2 - midY * scale;

    d3.select(this.canvas)
      .transition()
      .duration(750)
      .call(
        this.zoom.transform,
        d3.zoomIdentity.translate(tx, ty).scale(scale)
      );
  }

  exportImage() {
    const exportCanvas = document.createElement('canvas');
    const scale = 2;
    exportCanvas.width = this.width * scale;
    exportCanvas.height = this.height * scale;
    const expCtx = exportCanvas.getContext('2d');

    expCtx.fillStyle = '#0b0f19';
    expCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    expCtx.drawImage(this.canvas, 0, 0, exportCanvas.width, exportCanvas.height);

    const link = document.createElement('a');
    link.download = `linaje-grafo-${Date.now()}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
  }
}

window.ObsidianGraph = ObsidianGraph;
