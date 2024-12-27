import L from 'leaflet';
    import 'leaflet-draw';

    const map = L.map('map').setView([51.505, -0.09], 13);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    const calculateRadius = (area) => {
      return Math.sqrt(area / Math.PI) * 1000; // Convert km² to meters
    };

    map.on('click', (e) => {
      const radius = calculateRadius(5); // 5 km²
      const circle = L.circle(e.latlng, { radius }).addTo(map);
      drawnItems.addLayer(circle);
      updateInfo(circle);
    });

    const updateInfo = (layer) => {
      const center = layer.getLatLng();
      const radius = layer.getRadius();
      document.getElementById('info').innerHTML = `
        <strong>Center:</strong> [${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}]<br>
        <strong>Radius:</strong> ${(radius / 1000).toFixed(2)} km
      `;
    };

    document.getElementById('save').onclick = () => {
      if (drawnItems.getLayers().length > 0) {
        alert('Geofence saved!');
      }
    };

    document.getElementById('edit').onclick = () => {
      if (drawnItems.getLayers().length > 0) {
        alert('Edit mode activated!');
      }
    };

    document.getElementById('delete').onclick = () => {
      drawnItems.clearLayers();
      document.getElementById('info').innerHTML = '';
    };
