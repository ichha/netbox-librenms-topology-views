/**
 * Zabbix Traffic Overlay for NetBox Topology Views
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

    function waitForGraph() {
        if (window.graph && window.edges) {
            _graph = window.graph;
            _edges = window.edges;
            console.log('[ZabbixTraffic] graph and edges ready. Initializing overlay.');
            init();
        } else {
            _retries++;
            if (_retries > MAX_RETRIES) {
                console.warn('[ZabbixTraffic] Timed out waiting for window.graph / window.edges');
                return;
            }
            setTimeout(waitForGraph, 500);
        }
    }

    function injectZabbixModal() {
        var existing = document.getElementById('zabbixLinkModal');
        if (existing) {
            existing.remove(); // Force refresh template if already injected by a previous script version
        }
        var html = `
            <div class="modal fade" id="zabbixLinkModal" tabindex="-1" aria-labelledby="zabbixLinkModalLabel" aria-hidden="true">
              <div class="modal-dialog modal-lg modal-dialog-centered">
                <div class="modal-content" style="background-color: #fff; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); border: none;">
                  <div class="modal-header" style="border-bottom: 1px solid #eee; padding: 15px 20px; display: block;">
                    <div class="d-flex justify-content-between align-items-center">
                        <h5 class="modal-title" id="zabbixLinkModalLabel" style="font-weight: 600; color: #333; margin-bottom: 0;">Link Traffic</h5>
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
                      <p class="mt-2 text-muted">Fetching Zabbix data...</p>
                    </div>
                    <div id="modal-chart-container" class="d-none">
                      <div class="row mb-4 text-center">
                        <div class="col-6">
                          <h6 style="color: #2ecc71; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; font-size: 11px;">Inbound (Received)</h6>
                          <div style="font-size: 26px; font-weight: bold; color: #2ecc71; line-height: 1.2;">
                            <span id="modal-in-last">--</span> 
                            <span style="font-size: 16px; opacity: 0.8;">(<span id="modal-in-util">--</span>)</span>
                          </div>
                          <div style="font-size: 11px; color: #888; margin-top: 5px;">
                            Avg: <span id="modal-in-avg" style="font-weight: 600;">--</span> | Max: <span id="modal-in-max" style="font-weight: 600;">--</span>
                          </div>
                        </div>
                        <div class="col-6" style="border-left: 1px solid #eee;">
                          <h6 style="color: #ffa500; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; font-size: 11px;">Outbound (Sent)</h6>
                          <div style="font-size: 26px; font-weight: bold; color: #ffa500; line-height: 1.2;">
                            <span id="modal-out-last">--</span> 
                            <span style="font-size: 16px; opacity: 0.8;">(<span id="modal-out-util">--</span>)</span>
                          </div>
                          <div style="font-size: 11px; color: #888; margin-top: 5px;">
                            Avg: <span id="modal-out-avg" style="font-weight: 600;">--</span> | Max: <span id="modal-out-max" style="font-weight: 600;">--</span>
                          </div>
                        </div>
                      </div>
                      <h6 style="font-size: 12px; color: #555; margin-bottom: 10px; font-weight: bold;">Latest Traffic Graph (2 Hours)</h6>
                      <div style="height: 280px; width: 100%;">
                        <canvas id="modalTrafficChart"></canvas>
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
        if (percent < 1) return '#aaaaaa';  // 0-1%   Default Gray
        if (percent < 10) return '#8b00ff'; // 1-10%  Purple
        if (percent < 25) return '#0000ff'; // 10-25% Blue
        if (percent < 40) return '#00ccff'; // 25-40% Cyan
        if (percent < 55) return '#00ff00'; // 40-55% Green
        if (percent < 70) return '#ffff00'; // 55-70% Yellow
        if (percent < 85) return '#ffa500'; // 70-85% Orange
        return '#ff0000';                   // 85-100% Red
    }

    // We now draw labels manually via afterDrawing, so native labels are cleared
    function clearNativeLabel(edge) {
        if (edge.label !== '') {
            _edges.update({ id: edge.id, label: '' });
        }
    }

    function buildSvgSparkline(inHistory, outHistory, width, height) {
        if ((!inHistory || inHistory.length < 2) && (!outHistory || outHistory.length < 2)) {
            return '<div style="text-align:center; color:#000; padding:15px; font-size:12px;">No history data available</div>';
        }

        var allValues = [];
        (inHistory || []).forEach(function(p) { allValues.push(p.y); });
        (outHistory || []).forEach(function(p) { allValues.push(p.y); });
        
        var maxVal = Math.max.apply(null, allValues) || 1;
        var leftPad = 45; // room for Y-axis labels
        var rightPad = 8;
        var topPad = 8;
        var bottomPad = 30; // room for time labels + legend
        var chartW = width - leftPad - rightPad;
        var chartH = height - topPad - bottomPad;

        function buildPath(history, color, fillColor) {
            if (!history || history.length < 2) return '';
            var points = [];
            for (var i = 0; i < history.length; i++) {
                var x = leftPad + (i / (history.length - 1)) * chartW;
                var y = topPad + chartH - (history[i].y / maxVal) * chartH;
                points.push(x.toFixed(1) + ',' + y.toFixed(1));
            }
            var line = '<polyline points="' + points.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round"/>';
            // Fill area
            var firstX = leftPad.toFixed(1);
            var lastX = (leftPad + chartW).toFixed(1);
            var baseY = (topPad + chartH).toFixed(1);
            var fillPoints = firstX + ',' + baseY + ' ' + points.join(' ') + ' ' + lastX + ',' + baseY;
            var area = '<polygon points="' + fillPoints + '" fill="' + fillColor + '"/>';
            return area + line;
        }

        // Grid lines and Y-axis labels
        var gridAndLabels = '';
        for (var i = 0; i <= 4; i++) {
            var val = maxVal * (1 - i / 4);
            var yPos = topPad + (i / 4) * chartH;
            gridAndLabels += '<text x="' + (leftPad - 5) + '" y="' + yPos.toFixed(1) + '" font-size="9" fill="#000" font-weight="600" text-anchor="end" dominant-baseline="middle">' + formatBpsShort(val) + '</text>';
            gridAndLabels += '<line x1="' + leftPad + '" y1="' + yPos.toFixed(1) + '" x2="' + (leftPad + chartW) + '" y2="' + yPos.toFixed(1) + '" stroke="#ddd" stroke-width="0.5" stroke-dasharray="3,3"/>';
        }
        // Axis lines
        gridAndLabels += '<line x1="' + leftPad + '" y1="' + topPad + '" x2="' + leftPad + '" y2="' + (topPad + chartH) + '" stroke="#999" stroke-width="1"/>';
        gridAndLabels += '<line x1="' + leftPad + '" y1="' + (topPad + chartH) + '" x2="' + (leftPad + chartW) + '" y2="' + (topPad + chartH) + '" stroke="#999" stroke-width="1"/>';

        // Time labels
        var timeLabels = '';
        var primary = (inHistory && inHistory.length >= 2) ? inHistory : outHistory;
        if (primary && primary.length >= 2) {
            var numTimeLabels = Math.min(5, primary.length);
            for (var t = 0; t < numTimeLabels; t++) {
                var idx = Math.floor(t * (primary.length - 1) / (numTimeLabels - 1));
                var timeStr = new Date(primary[idx].x).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12:false});
                var tx = leftPad + (idx / (primary.length - 1)) * chartW;
                timeLabels += '<text x="' + tx.toFixed(1) + '" y="' + (topPad + chartH + 14) + '" font-size="9" fill="#000" font-weight="500" text-anchor="middle">' + timeStr + '</text>';
            }
        }

        var svg = '<svg width="' + width + '" height="' + height + '" xmlns="http://www.w3.org/2000/svg" style="display:block; background:#fff; border:1px solid #e0e0e0; border-radius:4px;">';
        svg += gridAndLabels;
        svg += buildPath(inHistory, '#16a34a', 'rgba(22,163,74,0.2)');
        svg += buildPath(outHistory, '#ea580c', 'rgba(234,88,12,0.2)');
        svg += timeLabels;
        // Legend at bottom
        var legendY = height - 8;
        var legendMidX = leftPad + chartW / 2;
        svg += '<rect x="' + (legendMidX - 70) + '" y="' + (legendY - 8) + '" width="10" height="10" fill="#16a34a" rx="2"/>';
        svg += '<text x="' + (legendMidX - 57) + '" y="' + legendY + '" font-size="10" fill="#000" font-weight="600">Inbound</text>';
        svg += '<rect x="' + (legendMidX + 10) + '" y="' + (legendY - 8) + '" width="10" height="10" fill="#ea580c" rx="2"/>';
        svg += '<text x="' + (legendMidX + 23) + '" y="' + legendY + '" font-size="10" fill="#000" font-weight="600">Outbound</text>';
        svg += '</svg>';
        return svg;
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

        // Build SVG sparkline from history
        var inHistory = data.history ? data.history['in'] : [];
        var outHistory = data.history ? data.history['out'] : [];
        var sparklineSvg = buildSvgSparkline(inHistory, outHistory, 460, 160);

        // Compute actual time range from history data
        var graphLabel = 'Traffic Graph';
        var historySource = (inHistory && inHistory.length >= 2) ? inHistory : outHistory;
        if (historySource && historySource.length >= 2) {
            var firstMs = new Date(historySource[0].x).getTime();
            var lastMs = new Date(historySource[historySource.length - 1].x).getTime();
            var diffHours = Math.round((lastMs - firstMs) / (1000 * 60 * 60));
            if (diffHours >= 24) {
                graphLabel = 'Traffic Graph (Last ' + Math.round(diffHours / 24) + ' Day' + (Math.round(diffHours / 24) > 1 ? 's' : '') + ')';
            } else if (diffHours >= 1) {
                graphLabel = 'Traffic Graph (Last ' + diffHours + ' Hour' + (diffHours > 1 ? 's' : '') + ')';
            } else {
                var diffMins = Math.round((lastMs - firstMs) / (1000 * 60));
                graphLabel = 'Traffic Graph (Last ' + diffMins + ' Min)';
            }
        }
        
        var div = document.createElement('div');
        div.className = 'zabbix-traffic-tooltip';
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
                '<div style="font-size:12px; font-weight:800; color:#000; margin-bottom:6px;">📈 ' + graphLabel + '</div>' +
                sparklineSvg +
            '</div>' +
            // Footer
            '<div style="background:#eef2f7; padding:6px 14px; border-radius:0 0 6px 6px; font-size:10px; color:#000; text-align:center; border-top:1px solid #d0d5dd; font-weight:600;">' +
                'Data from: ' + devA + ' [' + portA + '] &nbsp;•&nbsp; Click cable for full chart' +
            '</div>';
        return div;
    }

    function fetchZabbixTrafficForEdges() {
        _edges.forEach(function (edge) {
            if (edge.cable_a_name && edge.cable_a_dev_name &&
                edge.cable_a_name !== 'device A name unknown' &&
                edge.cable_a_dev_name !== 'device A name unknown') {
                
                var apiUrl = '/api/plugins/zabbix2-traffic/traffic-data/' +
                    '?device=' + encodeURIComponent(edge.cable_a_dev_name) +
                    '&interface=' + encodeURIComponent(edge.cable_a_name) +
                    '&range=2h';
                    
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

                        edge.zabbixTraffic = data;
                        clearNativeLabel(edge);

                        // Build rich HTML tooltip for hover
                        var tooltipEl = buildTrafficTooltip(edge, data);

                        _edges.update({ 
                            id: edge.id, 
                            zabbixTraffic: data,
                            title: tooltipEl, // Update the HOVER tooltip with traffic data
                            label: '', // Clear native label
                            color: { color: maxColor, highlight: maxColor, hover: maxColor },
                            width: 3
                        });
                        
                        console.log('[ZabbixTraffic] Updated tooltip for edge', edge.id, edge.cable_a_dev_name + ' [' + edge.cable_a_name + ']');
                    })
                    .catch(function (err) {
                        console.error('[ZabbixTraffic] fetch error for edge ' + edge.id + ':', err);
                    });
            }
        });
    }

    var modalChartInstance = null;
    function openZabbixModalForEdge(edge) {
        var modalEl = document.getElementById('zabbixLinkModal');
        if (!modalEl) { 
            console.error('Modal element not found! Injecting dynamically...');
            injectZabbixModal();
            modalEl = document.getElementById('zabbixLinkModal');
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
        document.getElementById('zabbixLinkModalLabel').innerHTML =
            devA + ' [' + portA + '] ⇄ ' + devB + ' [' + portB + '] <span class="badge bg-secondary ms-2">' + speedStr + '</span>';
            
        // Explicitly show the data source
        document.getElementById('modal-data-source').textContent = devA + ' [' + portA + ']';

        var data = edge.zabbixTraffic;
        var inLast = data.stats['in'].last;
        var outLast = data.stats['out'].last;
        var speedBps = speedKbps ? speedKbps * 1000 : 10e9;
        
        var percentIn = ((inLast / speedBps) * 100).toFixed(1) + '%';
        var percentOut = ((outLast / speedBps) * 100).toFixed(1) + '%';

        document.getElementById('modal-in-last').textContent = formatBpsLong(inLast);
        document.getElementById('modal-in-avg').textContent = formatBpsLong(data.stats['in'].avg);
        document.getElementById('modal-in-max').textContent = formatBpsLong(data.stats['in'].max);
        document.getElementById('modal-in-util').textContent = percentIn;
        
        document.getElementById('modal-out-last').textContent = formatBpsLong(outLast);
        document.getElementById('modal-out-avg').textContent = formatBpsLong(data.stats['out'].avg);
        document.getElementById('modal-out-max').textContent = formatBpsLong(data.stats['out'].max);
        document.getElementById('modal-out-util').textContent = percentOut;

        loadingEl.classList.add('d-none');
        containerEl.classList.remove('d-none');

        var ctx = document.getElementById('modalTrafficChart').getContext('2d');
        if (modalChartInstance) { modalChartInstance.destroy(); }

        var inHistory = data.history['in'] || [];
        var outHistory = data.history['out'] || [];
        var primary = inHistory.length >= outHistory.length ? inHistory : outHistory;

        var labels = primary.map(function (item) {
            var d = new Date(item.x);
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        });

        var inGrad = ctx.createLinearGradient(0, 0, 0, 250);
        inGrad.addColorStop(0, 'rgba(46, 204, 113, 0.4)');
        inGrad.addColorStop(1, 'rgba(46, 204, 113, 0.01)');
        var outGrad = ctx.createLinearGradient(0, 0, 0, 250);
        outGrad.addColorStop(0, 'rgba(241, 196, 15, 0.4)');
        outGrad.addColorStop(1, 'rgba(241, 196, 15, 0.01)');

        modalChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Bits received (Inbound)',
                        data: inHistory.map(function (i) { return i.y; }),
                        borderColor: '#2ecc71', borderWidth: 2.2,
                        backgroundColor: inGrad, fill: true,
                        tension: 0.22, pointRadius: 0, pointHoverRadius: 5
                    },
                    {
                        label: 'Bits sent (Outbound)',
                        data: outHistory.map(function (i) { return i.y; }),
                        borderColor: '#f1c40f', borderWidth: 2.2,
                        backgroundColor: outGrad, fill: true,
                        tension: 0.22, pointRadius: 0, pointHoverRadius: 5
                    }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: '#6c757d', font: { size: 10 }, autoSkip: true, autoSkipPadding: 30 } },
                    y: { ticks: { color: '#6c757d', font: { size: 10 }, callback: function (v) { return formatBpsLong(v); } } }
                }
            }
        });
    }

    function drawTrafficLabels(ctx) {
        if (!_edges || !_graph) return;
        
        var edgeIds = _edges.getIds();
        edgeIds.forEach(function (edgeId) {
            var edge = _edges.get(edgeId);
            if (!edge || !edge.zabbixTraffic) return;
            
            var edgeObj = _graph.body.edges[edgeId];
            if (!edgeObj || !edgeObj.edgeType || !edgeObj.edgeType.getPoint) return;
            
            var inStr = formatBpsShort(edge.zabbixTraffic.stats['in'].last);
            var outStr = formatBpsShort(edge.zabbixTraffic.stats['out'].last);

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
                // Adjusting vertical alignment slightly for smaller text
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
            '  max-width: 520px !important;' +
            '  overflow: visible !important;' +
            '  pointer-events: none !important;' +
            '}' +
            'div.vis-tooltip * {' +
            '  color: inherit;' +
            '}' +
            'div.vis-tooltip .zabbix-traffic-tooltip {' +
            '  color: #000000;' +
            '}' +
            'div.vis-tooltip .zabbix-traffic-tooltip td,' +
            'div.vis-tooltip .zabbix-traffic-tooltip div,' +
            'div.vis-tooltip .zabbix-traffic-tooltip span,' +
            'div.vis-tooltip .zabbix-traffic-tooltip b {' +
            '  color: inherit;' +
            '}';
        document.head.appendChild(style);
        console.log('[ZabbixTraffic] Tooltip CSS injected.');
    }

    function init() {
        injectTooltipCSS();
        injectZabbixModal();

        _graph.on('afterDrawing', function (ctx) {
            drawTrafficLabels(ctx);
        });

        _graph.on('click', function (params) {
            if (params.edges.length > 0 && params.nodes.length === 0) {
                var edgeId = params.edges[0];
                var clickedEdge = _edges.get(edgeId);
                if (clickedEdge && clickedEdge.zabbixTraffic) {
                    // Short delay to avoid intercepting double-clicks!
                    clickTimeout = setTimeout(function() {
                        openZabbixModalForEdge(clickedEdge);
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

        fetchZabbixTrafficForEdges();
        setInterval(fetchZabbixTrafficForEdges, 60000);
        console.log('[ZabbixTraffic] Overlay initialised — fetching traffic data...');
    }

    waitForGraph();
})();
