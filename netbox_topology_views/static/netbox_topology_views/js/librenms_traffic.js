/**
 * LibreNMS Traffic Overlay for NetBox Topology Views
 * 
 * Standalone script — no bundling required.
 * Hooks into window.graph and window.edges exposed by app.js.
 */
(function () {
    'use strict';

    let _graph = null;
    let _edges = null;
    let _retries = 0;
    const MAX_RETRIES = 60; // 30 seconds max
    let clickTimeout = null;
    let activeEdge = null;
    let activeRange = '1d';

    function waitForGraph() {
        if (window.graph && window.edges) {
            _graph = window.graph;
            _edges = window.edges;
            console.log('[LibreNMSTraffic] graph and edges ready. Initializing overlay.');
            init();
        } else {
            _retries++;
            if (_retries > MAX_RETRIES) {
                console.warn('[LibreNMSTraffic] Timed out waiting for window.graph / window.edges');
                return;
            }
            setTimeout(waitForGraph, 500);
        }
    }

    function injectLibreNMSModal() {
        var existing = document.getElementById('librenmsLinkModal');
        if (existing) {
            existing.remove(); // Force refresh template if already injected by a previous script version
        }
        var html = `
            <div class="modal fade" id="librenmsLinkModal" tabindex="-1" aria-labelledby="librenmsLinkModalLabel" aria-hidden="true">
              <div class="modal-dialog modal-xl modal-dialog-centered">
                <div class="modal-content" style="background-color: #fff; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); border: none;">
                  <div class="modal-header" style="border-bottom: 1px solid #eee; padding: 15px 20px; display: block;">
                    <div class="d-flex justify-content-between align-items-center">
                        <h5 class="modal-title" id="librenmsLinkModalLabel" style="font-weight: 600; color: #333; margin-bottom: 0;">Link Traffic</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div style="font-size: 12px; color: #666; margin-top: 8px;">
                        <span class="badge bg-info text-dark" style="margin-right: 5px;">Data Source</span> 
                        <span id="modal-data-source" style="font-family: monospace;">--</span>
                    </div>
                  </div>
                  <div class="modal-body" style="padding: 20px;">
                    <div id="modal-loading" class="text-center py-4">
                      <div class="spinner-border text-primary" role="status">
                        <span class="visually-hidden">Loading...</span>
                      </div>
                      <p class="mt-2 text-muted">Fetching LibreNMS data...</p>
                    </div>
                    <div id="modal-chart-container" class="d-none">
                      <div class="row mb-4 text-center">
                        <div class="col-6">
                          <h6 style="color: #2ecc71; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; font-size: 11px;">Inbound (Received)</h6>
                          <div style="font-size: 26px; font-weight: bold; color: #2ecc71; line-height: 1.2;">
                            <span id="modal-in-last">--</span> 
                            <span style="font-size: 16px; opacity: 0.8;">(<span id="modal-in-util">--</span>)</span>
                          </div>
                        </div>
                        <div class="col-6" style="border-left: 1px solid #eee;">
                          <h6 style="color: #ffa500; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; font-size: 11px;">Outbound (Sent)</h6>
                          <div style="font-size: 26px; font-weight: bold; color: #ffa500; line-height: 1.2;">
                            <span id="modal-out-last">--</span> 
                            <span style="font-size: 16px; opacity: 0.8;">(<span id="modal-out-util">--</span>)</span>
                          </div>
                        </div>
                      </div>
                      
                      <!-- Range buttons for modal graph -->
                      <div class="d-flex justify-content-between align-items-center mb-3">
                        <h6 style="font-size: 12px; color: #555; margin-bottom: 0; font-weight: bold;">Traffic Graph</h6>
                        <div class="btn-group" role="group" id="modal-range-buttons">
                          <button type="button" class="btn btn-outline-secondary btn-sm active" data-range="1d">24 Hours</button>
                          <button type="button" class="btn btn-outline-secondary btn-sm" data-range="2d">48 Hours</button>
                          <button type="button" class="btn btn-outline-secondary btn-sm" data-range="7d">7 Days</button>
                          <button type="button" class="btn btn-outline-secondary btn-sm" data-range="30d">30 Days</button>
                          <button type="button" class="btn btn-outline-secondary btn-sm" data-range="1y">1 Year</button>
                        </div>
                      </div>
                      
                      <div class="librenms-modal-graph-wrapper" style="width: 100%; border: 1px solid #e0e0e0; border-radius: 6px; overflow: hidden; background: #fff; box-shadow: 0 4px 15px rgba(0,0,0,0.05); transition: transform 0.25s ease;">
                        <img id="modalTrafficImg" src="" style="width: 100%; display: block; max-height: 500px; object-fit: contain;" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', html);
    }

    function formatBpsLong(bps) {
        if (bps === undefined || bps === null || isNaN(bps)) return '0 bps';
        if (bps >= 1e9) return (bps / 1e9).toFixed(2) + ' Gbps';
        if (bps >= 1e6) return (bps / 1e6).toFixed(2) + ' Mbps';
        if (bps >= 1e3) return (bps / 1e3).toFixed(2) + ' kbps';
        return bps.toFixed(2) + ' bps';
    }

    function formatBpsShort(bps) {
        if (bps === undefined || bps === null || isNaN(bps)) return '0';
        if (bps >= 1e9) return (bps / 1e9).toFixed(1) + 'G';
        if (bps >= 1e6) return (bps / 1e6).toFixed(1) + 'M';
        if (bps >= 1e3) return (bps / 1e3).toFixed(1) + 'k';
        return bps.toFixed(0);
    }

    function getTrafficColor(percent) {
        if (percent <= 0) return '#000000'; // 0%      Black
        if (percent < 1) return '#aaaaaa';  // 0-1%   Default Gray
        if (percent < 10) return '#8b00ff'; // 1-10%  Purple
        if (percent < 25) return '#0000ff'; // 10-25% Blue
        if (percent < 40) return '#00ccff'; // 25-40% Cyan
        if (percent < 55) return '#00ff00'; // 40-55% Green
        if (percent < 70) return '#ffff00'; // 55-70% Yellow
        if (percent < 85) return '#ffa500'; // 70-85% Orange
        return '#ff0000';                   // 85-100% Red
    }

    function clearNativeLabel(edge) {
        if (edge.label !== '') {
            _edges.update({ id: edge.id, label: '' });
        }
    }

    function buildTrafficTooltip(edge, data) {
        var devA = edge.cable_a_dev_name || 'Unknown A';
        var portA = edge.cable_a_name || 'port';
        var devB = edge.cable_b_dev_name || 'Unknown B';
        var portB = edge.cable_b_name || 'port';
        
        var speedKbps = edge.cable_a_speed || edge.cable_b_speed;
        var speedBps = speedKbps ? speedKbps * 1000 : 10e9;
        var speedStr = speedKbps ? formatBpsLong(speedKbps * 1000) : '10 Gbps (Default)';
        
        var inLast = data.stats['in'].last;
        var outLast = data.stats['out'].last;
        var inAvg = data.stats['in'].avg;
        var outAvg = data.stats['out'].avg;
        var inMax = data.stats['in'].max;
        var outMax = data.stats['out'].max;
        
        var percentIn = ((inLast / speedBps) * 100).toFixed(1);
        var percentOut = ((outLast / speedBps) * 100).toFixed(1);

        var imgUrl = '/api/plugins/librenms/traffic-data/' +
            '?device=' + encodeURIComponent(edge.cable_a_dev_name) +
            '&interface=' + encodeURIComponent(edge.cable_a_name) +
            '&range=1d&width=820&height=350';
        
        var div = document.createElement('div');
        div.className = 'librenms-traffic-tooltip';
        div.innerHTML = 
            '<div style="background:#1e293b; color:#fff; padding:10px 14px; border-radius:6px 6px 0 0; font-weight:700; font-size:14px;">' +
                devA + ' ⇄ ' + devB +
            '</div>' +
            // Termination + Speed
            '<div style="background:#eef2f7; padding:8px 14px; border-bottom:1px solid #d0d5dd;">' +
                '<table style="width:100%; border-collapse:collapse; font-size:12px;">' +
                    '<tr><td style="padding:2px 0; color:#000; font-weight:700;">Termination A:</td><td style="padding:2px 8px; color:#000;">' + devA + ' [<b>' + portA + '</b>]</td></tr>' +
                    '<tr><td style="padding:2px 0; color:#000; font-weight:700;">Termination B:</td><td style="padding:2px 8px; color:#000;">' + devB + ' [<b>' + portB + '</b>]</td></tr>' +
                    '<tr><td style="padding:2px 0; color:#000; font-weight:700;">Speed:</td><td style="padding:2px 8px; color:#000; font-weight:700;">' + speedStr + '</td></tr>' +
                '</table>' +
            '</div>' +
            // Traffic stats table
            '<div style="padding:10px 14px; background:#fff;">' +
                '<table style="width:100%; border-collapse:collapse; font-size:13px;">' +
                    '<tr style="border-bottom:2px solid #ccc;">' +
                        '<td style="padding:5px 0; width:25%;"></td>' +
                        '<td style="padding:5px 8px; font-weight:800; color:#15803d; text-align:center; font-size:13px;">▼ IN</td>' +
                        '<td style="padding:5px 8px; font-weight:800; color:#c2410c; text-align:center; font-size:13px;">▲ OUT</td>' +
                    '</tr>' +
                    '<tr style="border-bottom:1px solid #e5e5e5;">' +
                        '<td style="padding:6px 0; color:#000; font-weight:800;">Current</td>' +
                        '<td style="padding:6px 8px; text-align:center; color:#15803d; font-weight:800; font-size:15px;">' + formatBpsLong(inLast) + ' <span style="font-size:12px;">(' + percentIn + '%)</span></td>' +
                        '<td style="padding:6px 8px; text-align:center; color:#c2410c; font-weight:800; font-size:15px;">' + formatBpsLong(outLast) + ' <span style="font-size:12px;">(' + percentOut + '%)</span></td>' +
                    '</tr>' +
                    '<tr style="border-bottom:1px solid #e5e5e5;">' +
                        '<td style="padding:5px 0; color:#000; font-weight:700;">Average</td>' +
                        '<td style="padding:5px 8px; text-align:center; color:#000; font-weight:600;">' + formatBpsLong(inAvg) + '</td>' +
                        '<td style="padding:5px 8px; text-align:center; color:#000; font-weight:600;">' + formatBpsLong(outAvg) + '</td>' +
                    '</tr>' +
                    '<tr>' +
                        '<td style="padding:5px 0; color:#000; font-weight:700;">Max</td>' +
                        '<td style="padding:5px 8px; text-align:center; color:#000; font-weight:600;">' + formatBpsLong(inMax) + '</td>' +
                        '<td style="padding:5px 8px; text-align:center; color:#000; font-weight:600;">' + formatBpsLong(outMax) + '</td>' +
                    '</tr>' +
                '</table>' +
            '</div>' +
            // Graph section
            '<div style="padding:10px 14px 8px; background:#f8fafc; border-top:1px solid #d0d5dd;">' +
                '<div style="font-size:12px; font-weight:800; color:#000; margin-bottom:6px;">📈 Traffic Graph (Last 24 Hours)</div>' +
                '<div style="width:100%; max-width:820px; height:350px; overflow:hidden; border:1px solid #e0e0e0; border-radius:4px; background:#fff;">' +
                    '<img src="' + imgUrl + '" style="width:100%; height:100%; object-fit:fill; display:block;" />' +
                '</div>' +
            '</div>' +
            // Footer
            '<div style="background:#eef2f7; padding:6px 14px; border-radius:0 0 6px 6px; font-size:10px; color:#000; text-align:center; border-top:1px solid #d0d5dd; font-weight:600;">' +
                'Data from: ' + devA + ' [' + portA + '] &nbsp;•&nbsp; Click cable for full chart' +
            '</div>';
        return div;
    }

    function fetchLibreNMSTrafficForEdges() {
        _edges.forEach(function (edge) {
            if (edge.cable_a_name && edge.cable_a_dev_name &&
                edge.cable_a_name !== 'device A name unknown' &&
                edge.cable_a_dev_name !== 'device A name unknown') {
                
                var apiUrl = '/api/plugins/librenms/traffic-data/' +
                    '?device=' + encodeURIComponent(edge.cable_a_dev_name) +
                    '&interface=' + encodeURIComponent(edge.cable_a_name) +
                    '&format=json';
                    
                fetch(apiUrl)
                    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
                    .then(function (data) {
                        var inLast = data.stats['in'].last;
                        var outLast = data.stats['out'].last;

                        var speedKbps = edge.cable_a_speed || edge.cable_b_speed;
                        var speedBps = speedKbps ? speedKbps * 1000 : 10e9;

                        var percentIn = (inLast / speedBps) * 100;
                        var percentOut = (outLast / speedBps) * 100;
                        
                        var maxPercent = Math.max(percentIn, percentOut);
                        var maxColor = getTrafficColor(maxPercent);

                        edge.librenmsTraffic = data;
                        clearNativeLabel(edge);

                        // Build rich HTML tooltip for hover
                        var tooltipEl = buildTrafficTooltip(edge, data);

                        _edges.update({ 
                            id: edge.id, 
                            librenmsTraffic: data,
                            title: tooltipEl, // Update the HOVER tooltip with traffic data
                            label: '', // Clear native label
                            color: { color: maxColor, highlight: maxColor, hover: maxColor },
                            width: 3
                        });
                        
                        console.log('[LibreNMSTraffic] Updated tooltip for edge', edge.id, edge.cable_a_dev_name + ' [' + edge.cable_a_name + ']');
                    })
                    .catch(function (err) {
                        console.error('[LibreNMSTraffic] fetch error for edge ' + edge.id + ':', err);
                    });
            }
        });
    }

    function openLibreNMSModalForEdge(edge) {
        var modalEl = document.getElementById('librenmsLinkModal');
        if (!modalEl) { 
            console.error('Modal element not found! Injecting dynamically...');
            injectLibreNMSModal();
            modalEl = document.getElementById('librenmsLinkModal');
        }
        var modal = new bootstrap.Modal(modalEl);
        modal.show();

        var loadingEl = document.getElementById('modal-loading');
        var containerEl = document.getElementById('modal-chart-container');
        loadingEl.classList.remove('d-none');
        containerEl.classList.add('d-none');

        var speedKbps = edge.cable_a_speed || edge.cable_b_speed;
        var speedStr = speedKbps ? formatBpsLong(speedKbps * 1000) : '10 Gbps (Fallback)';
        
        var devA = edge.cable_a_dev_name || 'Unknown A';
        var portA = edge.cable_a_name || 'port';
        var devB = edge.cable_b_dev_name || 'Unknown B';
        var portB = edge.cable_b_name || 'port';
        
        // Show BOTH termination points in title
        document.getElementById('librenmsLinkModalLabel').innerHTML =
            devA + ' [' + portA + '] ⇄ ' + devB + ' [' + portB + '] <span class="badge bg-secondary ms-2">' + speedStr + '</span>';
            
        // Explicitly show the data source
        document.getElementById('modal-data-source').textContent = devA + ' [' + portA + ']';

        var data = edge.librenmsTraffic;
        var inLast = data.stats['in'].last;
        var outLast = data.stats['out'].last;
        var speedBps = speedKbps ? speedKbps * 1000 : 10e9;
        
        var percentIn = ((inLast / speedBps) * 100).toFixed(1) + '%';
        var percentOut = ((outLast / speedBps) * 100).toFixed(1) + '%';

        document.getElementById('modal-in-last').textContent = formatBpsLong(inLast);
        document.getElementById('modal-in-util').textContent = percentIn;
        
        document.getElementById('modal-out-last').textContent = formatBpsLong(outLast);
        document.getElementById('modal-out-util').textContent = percentOut;

        loadingEl.classList.add('d-none');
        containerEl.classList.remove('d-none');

        // Reset active range button styling
        var buttons = document.querySelectorAll('#modal-range-buttons button');
        buttons.forEach(function(btn) {
            if (btn.getAttribute('data-range') === '1d') {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        // Set active edge and load graph image
        activeEdge = edge;
        activeRange = '1d';
        updateModalGraph();
    }

    function updateModalGraph() {
        if (!activeEdge) return;
        var modalImg = document.getElementById('modalTrafficImg');
        if (!modalImg) return;

        // Show a temporary loading placeholder style
        modalImg.style.opacity = '0.5';

        var imgUrl = '/api/plugins/librenms/traffic-data/' +
            '?device=' + encodeURIComponent(activeEdge.cable_a_dev_name) +
            '&interface=' + encodeURIComponent(activeEdge.cable_a_name) +
            '&range=' + activeRange +
            '&width=1350&height=480';

        modalImg.src = imgUrl;
        modalImg.onload = function() {
            modalImg.style.opacity = '1.0';
        };
    }

    function drawTrafficLabels(ctx) {
        if (!_edges || !_graph) return;
        
        var edgeIds = _edges.getIds();
        edgeIds.forEach(function (edgeId) {
            var edge = _edges.get(edgeId);
            if (!edge || !edge.librenmsTraffic) return;
            
            var edgeObj = _graph.body.edges[edgeId];
            if (!edgeObj || !edgeObj.edgeType || !edgeObj.edgeType.getPoint) return;
            
            var inStr = formatBpsShort(edge.librenmsTraffic.stats['in'].last);
            var outStr = formatBpsShort(edge.librenmsTraffic.stats['out'].last);

            // Spaced a bit closer to the center: 33% and 67% along the cable curve
            var pos1 = 0.33;
            var pos2 = 0.67;
            
            function drawLabelAt(percent, text) {
                var pBase = edgeObj.edgeType.getPoint(percent);
                var pPrev = edgeObj.edgeType.getPoint(Math.max(0, percent - 0.01));
                var pNext = edgeObj.edgeType.getPoint(Math.min(1, percent + 0.01));
                
                var angle = Math.atan2(pNext.y - pPrev.y, pNext.x - pPrev.x);
                // Keep text upright
                if (angle > Math.PI / 2 || angle < -Math.PI / 2) {
                    angle += Math.PI;
                }

                ctx.save();
                ctx.translate(pBase.x, pBase.y);
                ctx.rotate(angle);
                
                ctx.font = '10px Helvetica, Arial, sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                
                var metrics = ctx.measureText(text);
                var width = metrics.width + 6; // tighter padding
                var height = 14; // shorter height
                
                // Solid background box
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                if (ctx.roundRect) {
                    ctx.roundRect(-width/2, -height/2, width, height, 3);
                } else {
                    ctx.rect(-width/2, -height/2, width, height);
                }
                ctx.fill();
                
                // Light border
                ctx.strokeStyle = '#cccccc';
                ctx.lineWidth = 1;
                ctx.stroke();

                // Text
                ctx.fillStyle = '#333333';
                ctx.fillText(text, 0, 0.5); 
                
                ctx.restore();
            }

            // InStr is drawn close to Termination A (0%), OutStr close to Termination B (100%)
            drawLabelAt(pos1, inStr);
            drawLabelAt(pos2, outStr);
        });
    }

    function injectTooltipCSS() {
        var style = document.createElement('style');
        style.textContent = 
            'div.vis-tooltip {' +
            '  background-color: #ffffff !important;' +
            '  border: 1px solid #ccc !important;' +
            '  border-radius: 8px !important;' +
            '  box-shadow: 0 8px 30px rgba(0,0,0,0.25) !important;' +
            '  padding: 0 !important;' +
            '  white-space: normal !important;' +
            '  color: #000000 !important;' +
            '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;' +
            '  font-size: 13px !important;' +
            '  max-width: 850px !important;' +
            '  overflow: visible !important;' +
            '  pointer-events: none !important;' +
            '}' +
            'div.vis-tooltip * {' +
            '  color: inherit;' +
            '}' +
            'div.vis-tooltip .librenms-traffic-tooltip {' +
            '  color: #000000;' +
            '}' +
            'div.vis-tooltip .librenms-traffic-tooltip td,' +
            'div.vis-tooltip .librenms-traffic-tooltip div,' +
            'div.vis-tooltip .librenms-traffic-tooltip span,' +
            'div.vis-tooltip .librenms-traffic-tooltip b {' +
            '  color: inherit;' +
            '}' +
            '.librenms-modal-graph-wrapper:hover {' +
            '  transform: scale(1.015);' +
            '  box-shadow: 0 8px 25px rgba(0,0,0,0.1) !important;' +
            '}';
        document.head.appendChild(style);
        console.log('[LibreNMSTraffic] Tooltip CSS injected.');
    }

    function init() {
        injectTooltipCSS();
        injectLibreNMSModal();

        _graph.on('afterDrawing', function (ctx) {
            drawTrafficLabels(ctx);
        });

        _graph.on('click', function (params) {
            if (params.edges.length > 0 && params.nodes.length === 0) {
                var edgeId = params.edges[0];
                var clickedEdge = _edges.get(edgeId);
                if (clickedEdge && clickedEdge.librenmsTraffic) {
                    // Short delay to avoid intercepting double-clicks!
                    clickTimeout = setTimeout(function() {
                        openLibreNMSModalForEdge(clickedEdge);
                    }, 250);
                }
            }
        });

        _graph.on('doubleClick', function (params) {
            // Cancel the single-click modal if the user double-clicks!
            if (clickTimeout) {
                clearTimeout(clickTimeout);
                clickTimeout = null;
            }
        });

        // Bind modal range button clicks
        document.addEventListener('click', function(e) {
            if (e.target && e.target.parentElement && e.target.parentElement.id === 'modal-range-buttons') {
                var buttons = e.target.parentElement.querySelectorAll('button');
                buttons.forEach(function(btn) { btn.classList.remove('active'); });
                e.target.classList.add('active');
                activeRange = e.target.getAttribute('data-range') || '1d';
                updateModalGraph();
            }
        });

        fetchLibreNMSTrafficForEdges();
        setInterval(fetchLibreNMSTrafficForEdges, 60000);
        console.log('[LibreNMSTraffic] Overlay initialised — fetching traffic data...');
    }

    waitForGraph();
})();
