// Globale Variablen für die aktuelle User-ID und Discord-ID
let currentUserId = null;
let currentUserDiscordId = null;
let MAX_FENCES = 1; // Default maximale Anzahl der Fences pro Benutzer
const MAX_SPAWNPOINTS = 2000; // Maximal erlaubte Spawnpunkte
const MAX_ROUTE_LENGTH = 10;

// Auswahl der UI-Elemente
const loadingOverlay = document.getElementById('loadingOverlay');
const timerDiv = document.getElementById('timerDiv');
const lastActionSpan = document.getElementById('lastActionSpan');
const stepCountDiv = document.getElementById('stepCount');

const drawFenceButton = document.getElementById('drawFence');
const drawBootstrapFenceButton = document.getElementById('drawBootstrapFence');

// Modal-Elemente
const nameModal = document.getElementById('nameModal');
const fenceNameInput = document.getElementById('fenceNameInput');
const saveNameButton = document.getElementById('saveNameButton');
const cancelNameButton = document.getElementById('cancelNameButton');

// Funktionen zum Anzeigen und Ausblenden des Lade-Overlays
function showLoading() {
  loadingOverlay.style.display = 'flex';
}

function hideLoading() {
  loadingOverlay.style.display = 'none';
}

// Letzte Aktion setzen und im UI anzeigen
function setLastAction(actionText) {
  if (lastActionSpan) {
    lastActionSpan.textContent = actionText;
  }
}

// Funktion zur Anzeige des Namensmodals mit optionalem Vorschlag
function showNameModal(callback, defaultName = '') {
  nameModal.style.display = 'flex';
  fenceNameInput.value = defaultName || '';

  // Entferne vorherige Event-Listener, um Mehrfachbindungen zu vermeiden
  saveNameButton.replaceWith(saveNameButton.cloneNode(true));
  cancelNameButton.replaceWith(cancelNameButton.cloneNode(true));

  // Referenziere die neuen Buttons nach dem Klonen
  const newSaveButton = document.getElementById('saveNameButton');
  const newCancelButton = document.getElementById('cancelNameButton');

  newSaveButton.addEventListener('click', () => {
    const name = fenceNameInput.value.trim();
    if (name === '') {
      alert('Ein Name ist erforderlich.');
      return;
    }
    nameModal.style.display = 'none';
    callback(name);
  });

  newCancelButton.addEventListener('click', () => {
    nameModal.style.display = 'none';
    callback(null);
  });
}

// Funktionen zum Laden der User-ID mit Promise
async function loadCurrentUser() {
  try {
    const response = await fetch('/api/user', {
      credentials: 'include',
    });
    if (!response.ok) {
      throw new Error('Nicht authentifiziert');
    }
    const user = await response.json();
    currentUserId = user.user.id;
    currentUserDiscordId = user.user.id; // `req.user.id` ist die `discordId`
    MAX_FENCES = user.max_fences || 1; // Dynamisch setzen, Standardwert 1

    console.log('Aktuelle User-ID geladen: ', currentUserId);
    console.log('Aktuelle Discord-ID geladen: ', currentUserDiscordId);
    console.log('Max Fences gesetzt auf:', MAX_FENCES);
    return user;
  } catch (error) {
    console.error('Fehler beim Laden des Benutzers:', error);
    window.location.href = '/auth/discord';
  }
}

// Überprüfen der Authentifizierung beim Start
async function checkAuthentication() {
  try {
    const user = await loadCurrentUser();
    if (user && user.user.id) {
      console.log('Benutzer ist authentifiziert mit ID:', currentUserId);
    } else {
      throw new Error('Benutzer-ID nicht geladen');
    }
  } catch (error) {
    console.error('Authentifizierungsfehler:', error);
    window.location.href = '/auth/discord';
  }
}

// Initialisierung der Karte
const map = L.map('map').setView([48.7758, 9.1829], 13);

// Hinzufügen der OSM Tile Layer
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// FeatureGroups zum Speichern der gezeichneten Fences und Bootstrap-Fences
const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

const bootstrapItems = new L.FeatureGroup();
map.addLayer(bootstrapItems);

// Neues FeatureGroup für Fences anderer Benutzer
const otherFenceItems = new L.FeatureGroup();
map.addLayer(otherFenceItems);

// Variablen zum Erkennen des aktuellen Zeichnungsmodus
let drawingMode = 'fence'; // 'fence' oder 'bootstrap'

// Arrays zum Speichern der hinzugefügten Layer
let coverageLayers = [];
let routeLayer;

// Variablen zur Speicherung der Coverage Layers und Route Layer für Bootstrap
let coverageLayersBootstrap = [];
let bootstrapRouteLayer = null;

// Grenzwerte definieren
// const MAX_SPAWNPOINTS = 2000; // Bereits oben definiert
// const MAX_ROUTE_LENGTH = 10; // Bereits oben definiert

// Variablen zur Speicherung der GeoJSON-Daten
let currentRouteGeoJSON = null;
let currentFenceGeoJSON = null;
let currentBootstrapFenceGeoJSON = null;
let currentBootstrapRouteGeoJSON = null;

// Buttons zum Wechseln zwischen Fence und Bootstrap-Fence Zeichnen
drawFenceButton.addEventListener('click', () => {
  drawingMode = 'fence';
  map.removeControl(drawControlBootstrap);
  map.addControl(drawControl);
});

drawBootstrapFenceButton.addEventListener('click', () => {
  drawingMode = 'bootstrap';
  map.removeControl(drawControl);
  map.addControl(drawControlBootstrap);
});

// Initialisiere die Zeichenkontrollen
const drawControl = new L.Control.Draw({
  position: 'topright',
  draw: {
    polygon: {
      allowIntersection: false,
      showArea: true,
      drawError: {
        color: '#e1e100',
        message: '<strong>Polygon darf sich nicht selbst überschneiden!</strong>',
      },
      shapeOptions: {
        color: '#97009c',
      },
    },
    polyline: false,
    rectangle: false,
    circle: false,
    circlemarker: false,
    marker: false,
  },
  edit: {
    featureGroup: drawnItems, // Nur eigene Fences sind editierbar
    remove: false, // Entferne die Löschfunktion, falls nicht benötigt
  },
});

const drawControlBootstrap = new L.Control.Draw({
  position: 'topright',
  draw: {
    polygon: {
      allowIntersection: false,
      showArea: true,
      drawError: {
        color: '#e1e100',
        message: '<strong>Polygon darf sich nicht selbst überschneiden!</strong>',
      },
      shapeOptions: {
        color: '#ff7800',
      },
    },
    polyline: false,
    rectangle: false,
    circle: false,
    circlemarker: false,
    marker: false,
  },
  edit: {
    featureGroup: bootstrapItems,
    remove: false, // Entferne die Löschfunktion, falls nicht benötigt
  },
});

// Zu Beginn das normale Fence-Zeichnen-Control hinzufügen
map.addControl(drawControl);

// Event-Handler für bearbeitete Layer
map.on('draw:edited', async function (e) {
  try {
    showLoading();
    const layers = e.layers;
    let fenceEdited = false;

    // Temporäre Variable, um den alten Namen zu speichern
    let oldName = '';

    // Verwende eine Schleife mit `for...in`, um die Layer zu durchlaufen
    for (const layerId in layers._layers) {
      const currentLayer = layers._layers[layerId];
      if (currentLayer instanceof L.Polygon) {
        const fenceId = currentLayer.fenceId;
        if (!fenceId) {
          alert('Fence-ID nicht gefunden. Bitte erstellen Sie die Fence erneut.');
          hideLoading();
          return;
        }

        // Abrufen der aktuellen Fence-Daten, um den alten Namen zu erhalten
        const fenceDataResponse = await fetch(`/api/fences/${fenceId}`, {
          credentials: 'include',
        });
        if (!fenceDataResponse.ok) {
          throw new Error(`Fehler beim Abrufen der Fence-Daten: ${fenceDataResponse.status} ${fenceDataResponse.statusText}`);
        }
        const fenceInfo = await fenceDataResponse.json();
        oldName = fenceInfo.name;

        // Konvertiere das bearbeitete Polygon zu GeoJSON
        const editedGeoJSON = currentLayer.toGeoJSON();
        currentFenceGeoJSON = editedGeoJSON;

        // **Wichtig:** Setze die `fenceId` in `currentFenceGeoJSON`
        currentFenceGeoJSON.fenceId = fenceId;

        // Rechne die Route basierend auf dem neuen Polygon und aktualisiere die Fence
        await updateFenceAndRecalculateRoute(fenceId, editedGeoJSON, oldName, currentLayer);
        fenceEdited = true;
      }
    }

    if (!fenceEdited) {
      alert('Keine Fence wurde bearbeitet.');
    }
    hideLoading();
  } catch (error) {
    console.error('Fehler bei der Bearbeitung:', error);
    alert(`Fehler bei der Bearbeitung der Fence: ${error.message}`);
    hideLoading();
  }
});

// Event-Handler für neue Polygone
map.on('draw:created', async function (e) {
  const layer = e.layer;
  if (layer instanceof L.Polygon) {
    if (drawingMode === 'fence') {
      const fenceCountResponse = await fetch('/api/fences/count', { credentials: 'include' });
      const fenceCountData = await fenceCountResponse.json();

      if (fenceCountData.count >= MAX_FENCES) {
        alert(`Sie können nicht mehr als ${MAX_FENCES} Fences erstellen.`);
        return; // Ende der Funktion, wenn das Limit erreicht ist.
      }

      // Fences haben Namen
      showNameModal(async (name) => {
        if (name) {
          // **Geänderte Zeile: Entferne das Löschen aller eigenen Fences**
          // drawnItems.clearLayers(); // Diese Zeile entfernt alle eigenen Fences. Entfernen, um mehrere Fences zu erlauben.
          drawnItems.addLayer(layer);
          const polygon = layer.toGeoJSON();
          currentFenceGeoJSON = polygon;
          await createFence(polygon, name, layer);
          // Nach dem Erstellen der Fence die Route berechnen und synchronisieren
          await processFence(polygon, name);
        } else {
          // Benutzer hat den Vorgang abgebrochen
          map.removeLayer(layer);
        }
      });
    } else if (drawingMode === 'bootstrap') {
      // Bootstrap-Fences haben keine Namen
      bootstrapItems.clearLayers();
      bootstrapItems.addLayer(layer);
      const polygon = layer.toGeoJSON();
      currentBootstrapFenceGeoJSON = polygon;
      await processBootstrapFence(polygon);
    }
  }
});

// Funktion zum Erstellen einer neuen Fence
async function createFence(polygon, name, layer) {
  showLoading();
  try {
    // Füge den Namen zu den Eigenschaften des GeoJSON hinzu
    if (!polygon.properties) {
      polygon.properties = {};
    }
    polygon.properties.name = name;

    // Speichere die Fence im Backend
    const response = await fetch('/api/fences', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ geojson: polygon, name: name }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Fehler beim Speichern der Fence');
    }

    const data = await response.json();
    console.log('Fence erfolgreich gespeichert:', data);

    if (data.fenceId) {
      // Weise die fenceId dem Layer zu
      layer.fenceId = data.fenceId;
      // **HINZUGEFÜGT:** Setze die fenceId in currentFenceGeoJSON
      currentFenceGeoJSON.fenceId = data.fenceId;
      // **HINZUGEFÜGT:** Setze den Fence-Namen in currentFenceGeoJSON
      currentFenceGeoJSON.properties.name = name;
      console.log(`Fence-ID ${data.fenceId} dem Layer zugewiesen.`);
    }

    alert('Fence erfolgreich gespeichert und Route berechnet!');

  } catch (error) {
    console.error('Fehler beim Erstellen der Fence:', error);
    alert(`Fehler beim Erstellen der Fence: ${error.message}`);
  } finally {
    hideLoading();
  }
}

// Funktion zum Aktualisieren einer bestehenden Fence und Recalculating der Route
async function updateFenceAndRecalculateRoute(fenceId, geojson, name, layer) {
  try {
    console.log('Start: Aktualisieren der Fence und Recalculating Route');

    // Aktualisiere die Fence im Backend
    const updateResponse = await fetch(`/api/fences/${fenceId}`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ geojson: geojson, name: name }),
    });

    if (!updateResponse.ok) {
      const errorData = await updateResponse.json();
      throw new Error(`${errorData.error || 'Fehler beim Aktualisieren der Fence'} (${updateResponse.status})`);
    }

    const updateData = await updateResponse.json();
    console.log('Fence erfolgreich aktualisiert:', updateData);

    alert('Fence erfolgreich aktualisiert! Route wird neu berechnet.');

    // Rechne die Route basierend auf dem neuen Polygon
    const points = await fetchSpawnPointsWithinFenceAsync(geojson);
    console.log(`Spawnpunkte abgerufen: ${points.length}`);
    if (points.length === 0) {
      alert('Keine Spawnpunkte innerhalb der ausgewählten Fläche gefunden. Bitte erstellen Sie zuerst ein Bootstrap.');
      return;
    }
    if (points.length > MAX_SPAWNPOINTS) { // **Geänderte Zeile: Überprüfe gegen MAX_SPAWNPOINTS**
      alert(`Zu viele Spawnpunkte (${points.length}). Maximal erlaubte Anzahl: ${MAX_SPAWNPOINTS}.`);
      return;
    }

    const estimatedRouteLength = estimateRouteLength(points);
    console.log(`Geschätzte Routenlänge: ${estimatedRouteLength} km`);
    if (estimatedRouteLength > MAX_ROUTE_LENGTH) {
      alert(`Die geschätzte Routenlänge von ${estimatedRouteLength.toFixed(2)} km überschreitet den Grenzwert von ${MAX_ROUTE_LENGTH} km.`);
      return;
    }

    const { selectedPositions, uncoveredPoints } = greedySetCover(points);
    console.log(`Ausgewählte Positionen: ${selectedPositions.length}`);
    console.log(`Uncovered Points: ${uncoveredPoints.length}`);
    if (selectedPositions.length >= 200) {
      alert(`Maximum von 200 Positionen erreicht. ${points.length - uncoveredPoints.length} von ${points.length} Spawnpunkten abgedeckt.`);
      return;
    } else if (uncoveredPoints.length > 0) {
      alert(`${uncoveredPoints.length} von ${points.length} Spawnpunkten sind nicht abgedeckt.`);
      return;
    } else {
      alert('Alle Spawnpunkte wurden erfolgreich abgedeckt!');
    }

    // Aktualisiere die Route
    createRouteWithinFence(selectedPositions, name);

    console.log('Route erfolgreich erstellt und Fence aktualisiert.');

    // **Wichtig:** Setze die `fenceId` in `currentFenceGeoJSON`
    currentFenceGeoJSON.fenceId = fenceId;

    // **Neuer Code:** Setze den Fence-Namen in `currentFenceGeoJSON`
    if (!currentFenceGeoJSON.properties) {
      currentFenceGeoJSON.properties = {};
    }
    currentFenceGeoJSON.properties.name = name;

    // Automatisches Synchronisieren der Fence nach Aktualisierung
    await syncFence();
  } catch (error) {
    console.error('Fehler beim Aktualisieren der Fence und Recalculating der Route:', error);
    alert(`Fehler beim Aktualisieren der Fence und Recalculating der Route: ${error.message}`);
  }
}

// Funktion zum Löschen einer bestehenden Fence
async function deleteFenceFromDatabase(fenceId) {
  try {
    const response = await fetch(`/api/fences/${fenceId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`${errorData.error || 'Fehler beim Löschen der Fence'} (${response.status})`);
    }
    console.log(`Fence-ID ${fenceId} erfolgreich gelöscht.`);
    alert('Fence erfolgreich gelöscht.');
  } catch (error) {
    console.error('Fehler beim Löschen der Fence:', error);
    alert(`Fehler beim Löschen der Fence: ${error.message}`);
  }
}

// Funktion zum Recalculating Route und Speichern der Fence
async function recalculateRouteAndSave(fenceId, editedGeoJSON, oldName, layer) {
  try {
    console.log('Start: Recalculating Route and Saving Fence');

    // Rechne die Route basierend auf dem neuen Polygon
    const points = await fetchSpawnPointsWithinFenceAsync(editedGeoJSON);
    console.log(`Spawnpunkte abgerufen: ${points.length}`);
    if (points.length === 0) {
      alert('Keine Spawnpunkte innerhalb der ausgewählten Fläche gefunden. Bitte erstellen Sie zuerst ein Bootstrap.');
      return;
    }
    if (points.length > MAX_SPAWNPOINTS) { // **Geänderte Zeile: Überprüfe gegen MAX_SPAWNPOINTS**
      alert(`Zu viele Spawnpunkte (${points.length}). Maximal erlaubte Anzahl: ${MAX_SPAWNPOINTS}.`);
      return;
    }

    const estimatedRouteLength = estimateRouteLength(points);
    console.log(`Geschätzte Routenlänge: ${estimatedRouteLength} km`);
    if (estimatedRouteLength > MAX_ROUTE_LENGTH) {
      alert(`Die geschätzte Routenlänge von ${estimatedRouteLength.toFixed(2)} km überschreitet den Grenzwert von ${MAX_ROUTE_LENGTH} km.`);
      return;
    }

    const { selectedPositions, uncoveredPoints } = greedySetCover(points);
    console.log(`Ausgewählte Positionen: ${selectedPositions.length}`);
    console.log(`Uncovered Points: ${uncoveredPoints.length}`);
    if (selectedPositions.length >= 200) {
      alert(`Maximum von 200 Positionen erreicht. ${points.length - uncoveredPoints.length} von ${points.length} Spawnpunkten abgedeckt.`);
      return;
    } else if (uncoveredPoints.length > 0) {
      alert(`${uncoveredPoints.length} von ${points.length} Spawnpunkten sind nicht abgedeckt.`);
      return;
    } else {
      alert('Alle Spawnpunkte wurden erfolgreich abgedeckt!');
    }

    // Aktualisiere die Fence und berechne die Route
    await updateFenceAndRecalculateRoute(fenceId, editedGeoJSON, oldName, layer);

    console.log('Route erfolgreich erstellt und Fence aktualisiert.');
  } catch (error) {
    console.error('Fehler beim Recalculating Route und Speichern der Fence:', error);
    alert(`Fehler beim Recalculating Route und Speichern der Fence: ${error.message}`);
  }
}

// Funktion zum Abrufen von Spawnpunkten (Promise-basiert)
async function fetchSpawnPointsWithinFenceAsync(polygon) {
  const bbox = turf.bbox(polygon);
  const [minLng, minLat, maxLng, maxLat] = bbox;
  try {
    const response = await fetch(`/api/spawnpoints?north=${maxLat}&south=${minLat}&east=${maxLng}&west=${minLng}`, {
      credentials: 'include',
    });
    if (!response.ok) {
      throw new Error(`Netzwerkantwort war nicht ok: ${response.statusText}`);
    }
    const data = await response.json();
    const points = data.filter((point) => {
      const pt = turf.point([point.lon, point.lat]);
      return turf.booleanPointInPolygon(pt, polygon);
    });
    return points;
  } catch (error) {
    console.error('Fehler beim Abrufen der Spawnpunkte:', error);
    alert(`Fehler beim Abrufen der Spawnpunkte: ${error.message}`);
    throw error;
  }
}

// Implementierung des Greedy Set-Cover Algorithmus
function greedySetCover(points) {
  const maxPositions = 200;
  const radius = 0.07; // in Kilometern
  const allPoints = points.map((p) => ({
    ...p,
    covered: false,
  }));
  const selectedPositions = [];
  let uncoveredPoints = allPoints.filter((p) => !p.covered);
  while (uncoveredPoints.length > 0 && selectedPositions.length < maxPositions) {
    let bestCandidate = null;
    let bestCandidateCover = [];
    for (const candidate of uncoveredPoints) {
      const circle = turf.circle([candidate.lon, candidate.lat], radius, {
        units: 'kilometers',
      });
      const coveredPoints = uncoveredPoints.filter((pt) => {
        const ptPoint = turf.point([pt.lon, pt.lat]);
        return turf.booleanPointInPolygon(ptPoint, circle);
      });
      if (coveredPoints.length > bestCandidateCover.length) {
        bestCandidate = candidate;
        bestCandidateCover = coveredPoints;
      }
    }
    if (bestCandidate) {
      bestCandidateCover.forEach((pt) => {
        pt.covered = true;
      });
      selectedPositions.push(bestCandidate);
      uncoveredPoints = allPoints.filter((p) => !p.covered);
    } else {
      break;
    }
  }
  return { selectedPositions, uncoveredPoints };
}

// Funktion zum Erstellen der Route
function createRouteWithinFence(selectedPositions, name) {
  const features = selectedPositions.map((pt) => turf.point([pt.lon, pt.lat]));
  const points = [...features];
  const route = [];
  let currentPoint = points.shift();
  route.push(currentPoint);
  while (points.length > 0) {
    let nearestDistance = Infinity;
    let nearestIndex = -1;
    points.forEach((pt, index) => {
      const distance = turf.distance(currentPoint, pt, { units: 'kilometers' });
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    if (nearestIndex !== -1) {
      currentPoint = points.splice(nearestIndex, 1)[0];
      route.push(currentPoint);
    } else {
      break;
    }
  }
  currentRouteGeoJSON = turf.featureCollection(route);
  updateStepCount(route.length);
  drawRouteAndCoverage(route, 'fence', name);
  // Da die Fence bereits aktualisiert wurde, keine weitere Aktion notwendig
}

// Funktion zur Schätzung der Routenlänge
function estimateRouteLength(points) {
  if (points.length <= 1) return 0;
  const turfPoints = points.map((pt) => turf.point([pt.lon, pt.lat]));
  const fc = turf.featureCollection(turfPoints);
  const hull = turf.convex(fc);
  if (!hull) {
    let maxDistance = 0;
    for (let i = 0; i < turfPoints.length; i++) {
      for (let j = i + 1; j < turfPoints.length; j++) {
        const dist = turf.distance(turfPoints[i], turfPoints[j], {
          units: 'kilometers',
        });
        if (dist > maxDistance) {
          maxDistance = dist;
        }
      }
    }
    return maxDistance * 2;
  }
  return turf.length(hull, { units: 'kilometers' });
}

// Funktion zum Aktualisieren der Schrittanzahl
function updateStepCount(count) {
  stepCountDiv.textContent = `Schritte: ${count}`;
}

// Funktion zum Zeichnen der Route und Abdeckungsbereiche
function drawRouteAndCoverage(route, mode = 'fence', name = 'Unnamed Fence') {
  if (mode === 'fence') {
    coverageLayers.forEach((layer) => map.removeLayer(layer));
    coverageLayers = [];
    if (routeLayer) {
      map.removeLayer(routeLayer);
      routeLayer = null;
    }
  } else if (mode === 'bootstrap') {
    coverageLayersBootstrap.forEach((layer) => map.removeLayer(layer));
    coverageLayersBootstrap = [];
    if (bootstrapRouteLayer) {
      map.removeLayer(bootstrapRouteLayer);
      bootstrapRouteLayer = null;
    }
  }

  const color = mode === 'fence' ? 'blue' : 'orange';
  route.forEach((point) => {
    const circle = L.circle([point.geometry.coordinates[1], point.geometry.coordinates[0]], {
      radius: 70, // in Metern (70 Meter entsprechen ca. 0.07 km)
      color: color,
      fillOpacity: 0.2,
    }).addTo(map);

    if (mode === 'fence') {
      coverageLayers.push(circle);
    } else if (mode === 'bootstrap') {
      coverageLayersBootstrap.push(circle);
    }
  });

  const latLngs = route.map((point) => [
    point.geometry.coordinates[1],
    point.geometry.coordinates[0],
  ]);

  if (mode === 'fence') {
    if (routeLayer) {
      map.removeLayer(routeLayer);
    }
    routeLayer = L.polyline(latLngs, { color: 'green' }).addTo(map);
    map.fitBounds(routeLayer.getBounds());

    // Popup mit Fence-Name hinzufügen
    routeLayer.bindPopup(`<strong>Fence Name:</strong> ${name}`).openPopup();

    // Permanenter Tooltip hinzufügen
    routeLayer.bindTooltip(`<strong>${name}</strong>`, {
      permanent: true,
      direction: 'center',
      className: 'fence-tooltip'
    });
  } else if (mode === 'bootstrap') {
    if (bootstrapRouteLayer) {
      map.removeLayer(bootstrapRouteLayer);
    }
    bootstrapRouteLayer = L.polyline(latLngs, { color: 'red' }).addTo(map);
    map.fitBounds(bootstrapRouteLayer.getBounds());

    // Popup ohne Namen hinzufügen
    bootstrapRouteLayer.bindPopup(`<strong>Bootstrap Route</strong>`).openPopup();
  }
}

// Funktion zum Speichern des Bootstrap
async function saveBootstrapToDatabase(fenceData, routeData) {
  try {
    const dataToSave = {
      fence: fenceData,
      route: routeData,
    };
    const response = await fetch('/api/bootstrap', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(dataToSave),
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Fehler beim Speichern des Bootstrap');
    }
    const data = await response.json();
    console.log('Bootstrap erfolgreich gespeichert:', data);
    alert('Bootstrap erfolgreich gespeichert!');
  } catch (error) {
    console.error('Fehler beim Speichern des Bootstrap:', error);
    alert(`Fehler beim Speichern des Bootstrap: ${error.message}`);
  }
}

// Funktion zum Aktualisieren des Bootstrap in der Datenbank
async function updateBootstrapInDatabase(fenceData) {
  try {
    const dataToUpdate = {
      fence: fenceData,
      route: currentBootstrapRouteGeoJSON,
    };
    const response = await fetch('/api/bootstrap', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(dataToUpdate),
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Fehler beim Aktualisieren des Bootstrap');
    }
    const data = await response.json();
    console.log('Bootstrap erfolgreich aktualisiert:', data);
    alert('Bootstrap erfolgreich aktualisiert!');
  } catch (error) {
    console.error('Fehler beim Aktualisieren des Bootstrap:', error);
    alert(`Fehler beim Aktualisieren des Bootstrap: ${error.message}`);
  }
}

// Funktion zum Verarbeiten der Fence
async function processFence(polygon, name) {
  showLoading();
  try {
    const points = await fetchSpawnPointsWithinFenceAsync(polygon);
    if (points.length === 0) {
      alert('Keine Spawnpunkte innerhalb der ausgewählten Fläche gefunden. Bitte erstellen Sie zuerst ein Bootstrap.');
      hideLoading();
      return;
    }
    if (points.length > MAX_SPAWNPOINTS) { // **Geänderte Zeile: Überprüfe gegen MAX_SPAWNPOINTS**
      alert(`Zu viele Spawnpunkte (${points.length}). Maximal erlaubte Anzahl: ${MAX_SPAWNPOINTS}.`);
      hideLoading();
      return;
    }

    const estimatedRouteLength = estimateRouteLength(points);
    if (estimatedRouteLength > MAX_ROUTE_LENGTH) {
      alert(`Die geschätzte Routenlänge von ${estimatedRouteLength.toFixed(2)} km überschreitet den Grenzwert von ${MAX_ROUTE_LENGTH} km.`);
      hideLoading();
      return;
    }

    const { selectedPositions, uncoveredPoints } = greedySetCover(points);
    if (selectedPositions.length >= 200) {
      alert(`Maximum von 200 Positionen erreicht. ${points.length - uncoveredPoints.length} von ${points.length} Spawnpunkten abgedeckt.`);
      hideLoading();
      return;
    } else if (uncoveredPoints.length > 0) {
      alert(`${uncoveredPoints.length} von ${points.length} Spawnpunkten sind nicht abgedeckt.`);
      hideLoading();
      return;
    } else {
      alert('Alle Spawnpunkte wurden erfolgreich abgedeckt!');
    }

    createRouteWithinFence(selectedPositions, name);
    hideLoading();

    // Automatisches Synchronisieren der Fence nach Erstellung
    await syncFence();
    
    // **Neuer Code:** Seite neu laden nach erfolgreichem Synchronisieren
    location.reload();
    
  } catch (error) {
    console.error('Fehler beim Verarbeiten der Fence:', error);
    alert(`Fehler beim Verarbeiten der Fence: ${error.message}`);
    hideLoading();
  }
}

// Funktion zum Verarbeiten der Bootstrap-Fence ohne Namen
async function processBootstrapFence(polygon) {
  try {
    showLoading();
    const area = turf.area(polygon) / 1e6; // Quadratmeter zu Quadratkilometer
    if (area > 10) {
      alert(`Die Fläche der ausgewählten Zone beträgt ${area.toFixed(2)} km² und überschreitet das Maximum von 10 km².`);
      hideLoading();
      return;
    }
    const bbox = turf.bbox(polygon);
    const cellSide = 0.07 * 2;
    const options = {
      units: 'kilometers',
      mask: polygon,
    };
    const pointGrid = turf.pointGrid(bbox, cellSide, options);
    if (pointGrid.features.length === 0) {
      alert('Keine Punkte innerhalb der ausgewählten Fläche gefunden.');
      hideLoading();
      return;
    }
    currentBootstrapRouteGeoJSON = pointGrid;
    updateStepCount(pointGrid.features.length);
    drawRouteAndCoverage(pointGrid.features, 'bootstrap');
    await saveBootstrapToDatabase(currentBootstrapFenceGeoJSON, currentBootstrapRouteGeoJSON);

    // Automatisches Synchronisieren des Bootstrap
    await syncBootstrap();

    hideLoading();
  } catch (error) {
    console.error('Fehler beim Verarbeiten der Bootstrap-Fence:', error);
    alert(`Fehler beim Verarbeiten der Bootstrap-Fence: ${error.message}`);
    hideLoading();
  }
}

// Funktion zum Laden des Bootstrap
async function loadBootstrap() {
  showLoading();
  try {
    if (!currentUserId) {
      await loadCurrentUser();
    }
    const response = await fetch('/api/bootstrap', {
      credentials: 'include',
    });
    if (!response.ok) {
      throw new Error(`Netzwerkantwort war nicht ok: ${response.statusText}`);
    }
    const data = await response.json();
    if (data.fence && data.route) {
      currentBootstrapFenceGeoJSON = data.fence;
      currentBootstrapRouteGeoJSON = data.route;
      const bootstrapFenceLayer = L.geoJSON(currentBootstrapFenceGeoJSON, {
        style: {
          color: '#ff7800',
          weight: 2,
          opacity: 0.6,
        },
        onEachFeature: function (feature, layer) {
          layer.bindPopup(`<strong>Bootstrap Fence</strong>`);
          layer.on('click', () => {
            drawingMode = 'bootstrap';
            map.removeControl(drawControl);
            map.addControl(drawControlBootstrap);
            bootstrapItems.clearLayers();
            const coordinates = currentBootstrapFenceGeoJSON.geometry.coordinates[0];
            const latLngs = coordinates.map((coord) => [coord[1], coord[0]]);
            const polygon = L.polygon(latLngs, {
              color: '#ff7800',
              weight: 2,
            });
            bootstrapItems.addLayer(polygon);
            currentBootstrapFenceGeoJSON = {
              ...currentBootstrapFenceGeoJSON,
              properties: {
                ...currentBootstrapFenceGeoJSON.properties,
              },
            };
            if (!map.hasLayer(bootstrapItems)) {
              map.addLayer(bootstrapItems);
            }
            map.fitBounds(polygon.getBounds());
            alert('Sie können Änderungen an dieser Bootstrap-Fence vornehmen.');
          });
        },
      }).addTo(map);
      bootstrapItems.clearLayers();
      bootstrapItems.addLayer(bootstrapFenceLayer);
      drawRouteAndCoverage(currentBootstrapRouteGeoJSON.features, 'bootstrap');
    } else {
      console.log('Keine Bootstrap-Daten gefunden.');
      // Prüfen, ob die letzte Aktion "Bootstrap Sync" war => Hinweismeldung ausgeben
      const lastAction = await fetchLastSyncAction();
      if (lastAction === 'bootstrap') {
        alert('Keine Bootstrap-Route vorhanden! Bitte ggf. neu erstellen oder synchronisieren.');
      }
    }
  } catch (error) {
    console.error('Fehler beim Laden des Bootstrap:', error);
    if (error.message === 'Nicht authentifiziert') {
      window.location.href = '/auth/discord';
    } else {
      alert(`Fehler beim Laden des Bootstrap: ${error.message}`);
    }
  } finally {
    hideLoading();
  }
}

// Funktion zum Laden der Fences
async function loadFences() {
  showLoading();
  try {
    if (!currentUserId) {
      await loadCurrentUser();
    }

    // Eigene Fences abrufen
    const ownResponse = await fetch('/api/fences', { credentials: 'include' });
    if (!ownResponse.ok) {
      throw new Error('Netzwerkantwort war nicht okay: ' + ownResponse.statusText);
    }
    const ownFences = await ownResponse.json();

    // Fences des Projekts 26 abrufen
    const projectId = 26;
    const projectResponse = await fetch(`/api/fences/by-project/${projectId}`, { credentials: 'include' });
    if (!projectResponse.ok) {
      throw new Error('Netzwerkantwort war nicht okay: ' + projectResponse.statusText);
    }
    const projectFences = await projectResponse.json();

    // Beide Fence-Sätze kombinieren
    const fenceDataArray = [...ownFences, ...projectFences];

    const bounds = L.latLngBounds(); // Bounds für fitBounds initialisieren
    if (fenceDataArray && fenceDataArray.length > 0) {
      fenceDataArray.forEach(fenceData => {
        // "geometry" parsen
        let fenceGeometry;
        try {
          fenceGeometry = typeof fenceData.geometry === 'string'
            ? JSON.parse(fenceData.geometry)
            : fenceData.geometry;
        } catch (error) {
          console.error('Fehler beim Parsen der Geometrie:', error);
          return; // Abbrechen, wenn das Parsen fehlgeschlagen ist
        }

        // Überprüfen, ob die Geometrie gültig ist
        if (fenceGeometry && fenceGeometry.coordinates) {
          // Angenommen, es handelt sich um ein Polygon oder Feature
          if (fenceGeometry.type === "Polygon" || fenceGeometry.type === "Feature") {
            const coordinates = fenceGeometry.type === "Feature" ? fenceGeometry.geometry.coordinates : fenceGeometry.coordinates;
            const coords = coordinates[0].map(coord => [coord[1], coord[0]]); // Umkehren von [lon, lat] zu [lat, lon]

            // Bestimmen der Farbe basierend auf Eigentümerschaft
            const isOwnFence = fenceData.isOwnFence;
            let color;
            if (isOwnFence) {
              color = '#97009c'; // Farbe für eigene Fences
            } else {
              color = '#808080'; // Grau für Fences anderer Benutzer
            }

            const polygon = L.polygon(coords, {
              color: color,
            });

            polygon.fenceId = fenceData.id; // ID zuweisen
            polygon.isOwnFence = isOwnFence; // Eigentumsflag

            polygon.bindPopup(`<strong>Fence Name:</strong> ${fenceData.name}`);
            polygon.bindTooltip(`<strong>${fenceData.name}</strong>`, {
              permanent: true,
              direction: 'center',
              className: 'fence-tooltip'
            });

            // Hinzufügen zur entsprechenden FeatureGroup
            if (isOwnFence) {
              drawnItems.addLayer(polygon); // Eigene Fences
            } else {
              otherFenceItems.addLayer(polygon); // Fences anderer Benutzer
            }

            bounds.extend(polygon.getBounds()); // Bounds aktualisieren
          }
        } else {
          console.warn('Ungültige Geometrie: ', fenceGeometry);
        }
      });

      // Passe die Karte an die neuen Bounds an, nur wenn gültige Geometrien vorhanden sind
      if (bounds.isValid()) {
        map.fitBounds(bounds);
      } else {
        console.error('Ungültige Bounds: ', bounds);
      }
    } else {
      console.log('Keine Fence gefunden.');
    }
  } catch (error) {
    console.error('Fehler beim Laden der Fences:', error);
    if (error.message === 'Nicht authentifiziert') {
      window.location.href = '/auth/discord';
    } else {
      alert(`Fehler beim Laden der Fences: ${error.message}`);
    }
  } finally {
    hideLoading();
  }
}

// Funktion zum Synchronisieren der Fence
async function syncFence() {
  try {
    if (!currentFenceGeoJSON) {
      alert('Keine Fence-Daten vorhanden.');
      return;
    }
    if (!currentUserId) {
      await loadCurrentUser();
    }

    const actionType = 'fence';

    // Payload erstellen
    const payload = createAreaPayload(currentFenceGeoJSON, currentRouteGeoJSON, currentUserId, actionType);

    console.log('Fence Sync-Payload:', JSON.stringify(payload, null, 2)); // Erweiterter Log

    const response = await fetch('/api/sync', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    console.log('Server Response Status:', response.status);
    const serverResponse = await response.json();
    console.log('Server Response Body:', serverResponse);

    if (!response.ok) {
      console.error('Fehler beim Synchronisieren der Fence:', response.status, serverResponse);
      alert(`Fehler beim Synchronisieren der Fence: ${serverResponse.error || 'Unbekannter Fehler'}`);
      return;
    }
    if (serverResponse.success) {
      alert('Fence erfolgreich synchronisiert!');
      setLastAction('Fence Sync');
    } else {
      alert(`Fehler beim Synchronisieren der Fence: ${serverResponse.error || 'Unbekannter Fehler'}`);
    }
  } catch (error) {
    console.error('Fehler beim Synchronisieren der Fence:', error);
    alert(`Fehler beim Synchronisieren der Fence: ${error.message}`);
  }
}

// Synchronisierungsfunktion für Bootstrap
async function syncBootstrap() {
  try {
    if (!currentBootstrapFenceGeoJSON || !currentBootstrapRouteGeoJSON) {
      alert('Keine Bootstrap-Daten vorhanden.');
      return;
    }
    if (!currentUserId) {
      await loadCurrentUser();
    }

    const actionType = 'bootstrap';

    // Payload erstellen
    const payload = createAreaPayload(currentBootstrapFenceGeoJSON, currentBootstrapRouteGeoJSON, currentUserId, actionType);

    console.log('Bootstrap Sync-Payload:', JSON.stringify(payload, null, 2)); // Erweiterter Log

    const response = await fetch('/api/sync', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    console.log('Server Response Status:', response.status);
    const serverResponse = await response.json();
    console.log('Server Response Body:', serverResponse);

    if (!response.ok) {
      console.error('Fehler beim Synchronisieren des Bootstrap:', response.status, serverResponse);
      alert(`Fehler beim Synchronisieren des Bootstrap: ${serverResponse.error || 'Unbekannter Fehler'}`);
      return;
    }
    if (serverResponse.success) {
      alert('Bootstrap erfolgreich synchronisiert! Starte 30 Minuten Countdown...');
      setLastAction('Bootstrap Sync');
      startCountdown(30 * 60);

      // Nach 30 Minuten nur die Route aus DB löschen (Fence behalten)
      setTimeout(() => {
        deleteBootstrapRouteFromDB();
      }, 30 * 60 * 1000);
    } else {
      alert(`Fehler beim Synchronisieren des Bootstrap: ${serverResponse.error || 'Unbekannter Fehler'}`);
    }
  } catch (error) {
    console.error('Fehler beim Synchronisieren des Bootstrap:', error);
    alert(`Fehler beim Synchronisieren des Bootstrap: ${error.message}`);
  }
}

// Funktion zum Löschen der Bootstrap-Route aus der Datenbank
async function deleteBootstrapRouteFromDB() {
  try {
    const response = await fetch('/api/bootstrap/route', {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error('Fehler beim Löschen der Bootstrap-Route:', response.status, errText);
      alert(`Fehler beim Löschen der Bootstrap-Route: ${errText}`);
    } else {
      console.log('Bootstrap-Route aus DB gelöscht.');
      setLastAction('Bootstrap Route gelöscht');
      alert('Bootstrap-Route erfolgreich gelöscht.');
    }
  } catch (error) {
    console.error('Fehler beim Aufruf von /api/bootstrap/route:', error);
    alert(`Fehler beim Löschen der Bootstrap-Route: ${error.message}`);
  }
}

// Countdown-Funktion
function startCountdown(seconds) {
  let timeLeft = seconds;
  timerDiv.style.display = 'block';

  const interval = setInterval(() => {
    timeLeft--;
    timerDiv.textContent = `Erkundung läuft... ${formatTime(timeLeft)} verbleibend.`;
    if (timeLeft <= 0) {
      clearInterval(interval);
      timerDiv.textContent = 'Erkundung beendet.';
    }
  }, 1000);
}

// Hilfsfunktion zur Zeitformatierung
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s < 10 ? '0' + s : s}s`;
}

// Funktion zum Erstellen einer Area-Payload für die Synchronisierung
function createAreaPayload(fenceGeoJSON, routeGeoJSON, userId, actionType) {
  const fenceCoords = parsePolygonToLatLon(fenceGeoJSON);
  const routeCoords = parseRouteToLatLon(routeGeoJSON);

  // Sicherstellen, dass die GeoJSON-Eigenschaften existieren
  if (!fenceGeoJSON.properties) {
    fenceGeoJSON.properties = {};
  }

  // Extrahiere den Fence-Namen aus den GeoJSON-Eigenschaften
  const fenceName = fenceGeoJSON.properties.name || 'UnnamedFence';

  // Überprüfen, ob der Fence-Name tatsächlich vorhanden ist
  if (!fenceName || fenceName.trim() === '') {
    console.warn('Fence-Name ist leer. Verwende Standardnamen.');
  }

  const payload = {
    enabled: true,
    geofence: fenceCoords,
    pokemon_mode: {
      workers: 1,
      enable_scout: false,
      invasion: false,
      route: routeCoords
    },
    enable_quests: true,
    quest_mode: {
      hours: [1, 10],
      route: routeCoords
    },
    actionType: actionType,
    // Kombiniere die Discord-ID mit dem Fence-Namen
    name: `${currentUserDiscordId.toString()}_${fenceName}`
  };

  return payload;
}

// Fence in lat/lon umwandeln
function parsePolygonToLatLon(geojson) {
  let result = [];
  if (geojson.type === 'Feature' && geojson.geometry.type === 'Polygon') {
    const coords = geojson.geometry.coordinates[0];
    coords.forEach((coord) => {
      result.push({ lat: coord[1], lon: coord[0] });
    });
  } else if (geojson.type === 'Polygon') {
    const coords = geojson.coordinates[0];
    coords.forEach((coord) => {
      result.push({ lat: coord[1], lon: coord[0] });
    });
  }
  return result;
}

// Route in lat/lon umwandeln
function parseRouteToLatLon(geojson) {
  let result = [];
  if (geojson.type === 'FeatureCollection') {
    geojson.features.forEach((feature) => {
      if (feature.geometry.type === 'Point') {
        const [lon, lat] = feature.geometry.coordinates;
        result.push({ lat, lon });
      }
    });
  } else if (geojson.type === 'Point') {
    const [lon, lat] = geojson.coordinates;
    result.push({ lat, lon });
  }
  return result;
}

// Letzte Aktion aus Datenbank/Server abfragen (falls gewünscht)
async function fetchLastSyncAction() {
  try {
    const res = await fetch('/api/user', { credentials: 'include' });
    if (!res.ok) {
      return null;
    }
    const { user, last_sync_action } = await res.json();
    if (last_sync_action) {
      return last_sync_action;
    }
    return null;
  } catch (err) {
    console.error('Fehler bei fetchLastSyncAction:', err);
    return null;
  }
}

// Initialisierungsfunktion
async function initialize() {
  try {
    await checkAuthentication();
    await loadFences(); // Existierende Fences laden
    await loadBootstrap(); // Bootstrap laden

    // Letzte Aktion anzeigen
    if (lastActionSpan) {
      const lastAction = await fetchLastSyncAction();
      if (lastAction) {
        lastActionSpan.textContent = lastAction;
      } else {
        lastActionSpan.textContent = 'Keine Aktion bisher';
      }
    }

    // Den aktuellen Standort des Benutzers setzen
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          map.setView([latitude, longitude], 13);
          L.marker([latitude, longitude])
            .addTo(map)
            .bindPopup('Sie sind hier')
            .openPopup();
        },
        (error) => {
          console.error('Fehler beim Abrufen der GPS-Position:', error);
          alert('GPS-Position konnte nicht abgerufen werden.');
        }
      );
    } else {
      alert('Geolocation ist nicht verfügbar.');
    }
  } catch (error) {
    console.error('Fehler bei der Initialisierung:', error);
    window.location.href = '/auth/discord';
  }
}




initialize();
